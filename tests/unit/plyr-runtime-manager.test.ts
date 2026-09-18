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
    expect(help.output).toContain('No command flushes Redis');
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
