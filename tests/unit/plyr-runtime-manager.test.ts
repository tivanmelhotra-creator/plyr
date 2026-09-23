import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, afterEach } from 'vitest';

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'plyr');
const tempDirs: string[] = [];

function run(args: string[], env: Record<string, string> = {}): { code: number; output: string } {
  try {
    const output = execFileSync(cli, args, {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (e) {
    const error = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('canonical Plyr runtime manager', () => {
  it('exposes the canonical lifecycle commands without touching application state', () => {
    const help = run(['--help']);
    expect(help.code).toBe(0);
    expect(help.output).toContain('./plyr install');
    expect(help.output).toContain('./plyr doctor --deep');
    expect(help.output).toContain('Normal lifecycle commands preserve Redis');
    expect(help.output).toContain('./plyr dev-docker');
  });

  it('reports dependency and readiness failures instead of claiming READY', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'plyr-runtime-test-'));
    tempDirs.push(dir);
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'REDIS_URL=redis://127.0.0.1:6399\nREAL_CHROME_HEADLESS=true\n');
    const result = run(['doctor'], { PLYR_ENV_FILE: envFile, PLYR_STATE_DIR: path.join(dir, 'state') });
    expect(result.code).toBe(1);
    expect(result.output).toContain('Redis');
    expect(result.output).toContain('Runtime: NOT READY');
  });

  it('uses deterministic native mode when Docker is unavailable', () => {
    const script = require('fs').readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    expect(script).toContain('Docker/Compose is not available');
    expect(script).toContain('docker_available && printf docker || printf native');
    expect(script).toContain('install-and-start-dev');
  });

  it('does not swallow required install/start failures and checks functional readiness', () => {
    const script = require('fs').readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    expect(script).not.toContain('system_install || true');
    expect(script).not.toContain('start_redis || true');
    expect(script).not.toContain('start_desktop || true');
    expect(script).toContain('docker_storage_ready');
    expect(script).toContain('active_mode');
    expect(script).toContain('npm ci');
  });

  it('isolates the disposable Docker workflow from persistent Compose state', () => {
    const fs = require('fs');
    const manager = fs.readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    const compose = fs.readFileSync(path.join(root, 'docker-compose.dev.yml'), 'utf8');
    expect(manager).toContain('DEV_PROJECT=plyr-dev');
    expect(manager).toContain('install_dev_docker_engine');
    expect(manager).toContain('docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin');
    expect(manager).toContain('build --no-cache --pull app');
    expect(manager).toContain('"${dc[@]}" build app');
    expect(manager).toContain('down --volumes --remove-orphans');
    expect(manager).toContain('up -d --no-build --force-recreate --wait --wait-timeout 180');
    expect(compose).toContain('127.0.0.1:3000:3000');
    expect(compose).toContain('API_TOKEN: admin123');
    expect(compose).not.toContain('env_file:');
    expect(compose).not.toContain('volumes:');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile).toContain('RUN npm ci --ignore-scripts');
    const buildStage = dockerfile.split('AS runtime')[0];
    expect(buildStage).toContain('COPY scripts ./scripts');
    expect(buildStage).toContain('COPY extension ./extension');
    expect(buildStage.indexOf('COPY scripts ./scripts')).toBeLessThan(buildStage.indexOf('RUN npm run build'));
    expect(buildStage.indexOf('COPY extension ./extension')).toBeLessThan(buildStage.indexOf('RUN npm run build'));
    expect(dockerfile).toContain('COPY extension ./extension');
    // apt-get in the image must never wait for interactive input (tzdata prompt).
    for (const line of dockerfile.split('\n').filter((l: string) => /apt-get install/.test(l))) {
      expect(line).toContain('DEBIAN_FRONTEND=noninteractive');
    }
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/docker-package.yml'), 'utf8');
    expect(workflow).toContain('      - scripts/**');
  });

  it('publishes one immutable image per commit and dev-docker prefers it for a clean checkout', () => {
    const fs = require('fs');
    const manager = fs.readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/docker-package.yml'), 'utf8');
    // Every push gets a full-SHA tag; dev-docker pulls exactly that tag.
    expect(workflow).toContain("branches: ['**']");
    expect(workflow).toContain('packages: write');
    expect(workflow).toContain('type=sha,format=long,prefix=');
    expect(workflow).toContain('cache-from: type=gha');
    expect(workflow).toContain('platforms: linux/amd64');
    expect(manager).toContain('pull "$repo:$sha"');
    expect(manager).toContain('tag "$repo:$sha" plyr-dev:local');
    // Uncommitted changes are never masked by a published image.
    expect(manager).toContain('status --porcelain');
    // The previous stack is only removed after an image was obtained.
    const body = manager.slice(manager.indexOf('\ndev_docker() {'));
    expect(body.indexOf('dev_docker_pull_prebuilt "$source"')).toBeLessThan(body.indexOf('down --volumes --remove-orphans'));
    expect(body.indexOf('dev_docker_build_local "$fresh"')).toBeLessThan(body.indexOf('down --volumes --remove-orphans'));
  });

  it('rejects unknown dev-docker options before touching Docker', () => {
    const result = run(['dev-docker', '--bogus']);
    expect(result.code).not.toBe(0);
    expect(result.output).toContain('unknown dev-docker option');
  });

  it('has one explicit non-interactive install contract and a fresh-machine Node bootstrap', () => {
    const manager = require('fs').readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    const installer = require('fs').readFileSync(path.join(root, 'install.sh'), 'utf8');
    expect(manager).toContain('if [[ -z "${AB_NO_PROMPT:-}" ]]');
    expect(manager).toContain('ask_public_domain || true');
    expect(installer).toContain('AB_NO_PROMPT=1 ./plyr install');
    expect(installer).toContain('require_node || return 1');
    expect(installer).toContain('install_node_offer');
    expect(installer).not.toContain('install_redis_native');
  });
});
