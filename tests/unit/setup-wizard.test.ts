/**
 * setup-wizard.test.ts — the launch questions (scripts/setup-wizard.sh).
 *
 * Driven through `script` so bash really sees a terminal; without a terminal
 * the wizard must never block and must keep the defaults.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const root = path.resolve(__dirname, '../..');
const wizard = path.join(root, 'scripts/setup-wizard.sh');
const hasScript = spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
  && process.platform === 'linux';
let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-wizard-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** Run a bash snippet with the wizard sourced, answering `answers` on a TTY. */
function drive(snippet: string, answers: string[] = [], tty = true): string {
  const file = path.join(dir, 'drive.sh');
  fs.writeFileSync(file, `ROOT_DIR=${dir}; STATE_DIR=${dir}/state; ENV_FILE=${dir}/.env\nsource ${wizard}\n${snippet}\n`);
  const input = answers.map((a) => `${a}\n`).join('');
  const cmd = tty ? ['script', ['-qec', `bash ${file}`, '/dev/null']] as const : ['bash', [file]] as const;
  const out = spawnSync(cmd[0], [...cmd[1]], { input, encoding: 'utf8', timeout: 20000, env: { ...process.env, AB_NO_PROMPT: '', PLYR_YES: '' } });
  return `${out.stdout}${out.stderr}`.replace(/\x1b\[[0-9;]*m/g, '');
}
const env = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');

describe('./plyr setup', () => {
  it.skipIf(!hasScript)('development: Enter, Enter = no login, a random token still exists', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=development\nAPI_TOKEN=admin123\n');
    const out = drive('plyr_setup "$ROOT_DIR" "$ENV_FILE" --if-needed', ['', '']);
    expect(out).toContain('(recommended — press Enter)');
    expect(env()).toMatch(/^AUTH_MODE=open$/m);
    expect(env()).toMatch(/^API_TOKEN=[0-9a-f]{48}$/m);
    expect(env()).toMatch(/^APP_ENV=development$/m);
  });

  it.skipIf(!hasScript)('server: generates the token and the webhook secret and shows the token', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=development\nAPI_TOKEN=admin123\n');
    const out = drive('plyr_setup "$ROOT_DIR" "$ENV_FILE"', ['2', '', '2', 'panel.example.com', '']);
    const tok = /^API_TOKEN=([0-9a-f]{48})$/m.exec(env())![1];
    expect(out).toContain(tok);
    expect(env()).toMatch(/^APP_ENV=server$/m);
    expect(env()).toMatch(/^AUTH_MODE=token$/m);
    expect(env()).toMatch(/^PUBLIC_DOMAIN=https:\/\/panel\.example\.com$/m);
    expect(env()).toMatch(/^WEBHOOK_SECRET=[0-9a-f]{48}$/m);
    // One line per key, always.
    expect(env().match(/^API_TOKEN=/gm)).toHaveLength(1);
  });

  it.skipIf(!hasScript)('accepts the user\'s own token and rejects a weak one first', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'API_TOKEN=admin123\n');
    const out = drive('plyr_setup "$ROOT_DIR" "$ENV_FILE"', ['2', '2', 'short', 'my_own_token_1234567890', '', '']);
    expect(out).toContain('Use at least 16 characters');
    expect(env()).toMatch(/^API_TOKEN=my_own_token_1234567890$/m);
  });

  it.skipIf(!hasScript)('a later start offers "start with the current settings" and changes nothing on Enter', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=server\nAPI_TOKEN=keep_me_abcdefghijklmn\n');
    fs.mkdirSync(path.join(dir, 'state')); fs.writeFileSync(path.join(dir, 'state/setup-done'), '');
    const before = env();
    const out = drive('plyr_setup "$ROOT_DIR" "$ENV_FILE" --if-needed', ['']);
    expect(out).toContain('Start Plyr with the current settings?');
    expect(env()).toBe(before);
  });

  it.skipIf(!hasScript)('a value written to .env replaces the same key saved in the panel', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=development\n');
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data/settings.env'), 'AUTH_MODE=token\nCODE_NODE_ENABLED=false\n');
    drive('plyr_setup "$ROOT_DIR" "$ENV_FILE"', ['', '']);
    const panel = fs.readFileSync(path.join(dir, 'data/settings.env'), 'utf8');
    expect(panel).not.toMatch(/AUTH_MODE/);
    expect(panel).toMatch(/CODE_NODE_ENABLED=false/);
  });

  it('never blocks without a terminal', () => {
    fs.writeFileSync(path.join(dir, '.env'), 'APP_ENV=development\n');
    const out = drive('plyr_setup "$ROOT_DIR" "$ENV_FILE" --if-needed; echo RC=$?', [], false);
    expect(out).toContain('RC=0');
    expect(env()).toBe('APP_ENV=development\n');
  });
});

describe('./plyr dev-docker questions', () => {
  it('--dev needs no token question and writes an open, random-token stack', () => {
    const out = drive(`dev_docker_setup dev '' "$ROOT_DIR/.plyr" && cat "$DEV_ENV_FILE"`, [], false);
    expect(out).toMatch(/^PLYR_DEV_AUTH_MODE=open$/m);
    expect(out).toMatch(/^PLYR_DEV_API_TOKEN=[0-9a-f]{48}$/m);
  });

  it('--prod --token new generates; --token keep reuses it next time', () => {
    const a = drive(`dev_docker_setup prod new "$ROOT_DIR/.plyr" && cat "$DEV_ENV_FILE"`, [], false);
    const t1 = /^PLYR_DEV_API_TOKEN=(\w+)$/m.exec(a)![1];
    expect(a).toMatch(/^PLYR_DEV_AUTH_MODE=token$/m);
    const b = drive(`dev_docker_setup prod keep "$ROOT_DIR/.plyr" && cat "$DEV_ENV_FILE"`, [], false);
    expect(b).toContain(`PLYR_DEV_API_TOKEN=${t1}`);
  });

  it('rejects a weak --token value', () => {
    const out = drive(`dev_docker_setup prod short "$ROOT_DIR/.plyr"; echo RC=$?`, [], false);
    expect(out).toContain('at least 16');
    expect(out).toContain('RC=1');
  });

  it.skipIf(!hasScript)('asks dev or prod when nothing is given', () => {
    const out = drive(`dev_docker_setup '' '' "$ROOT_DIR/.plyr" && echo "MODE=$DEV_SUMMARY_MODE"`, ['2', '']);
    expect(out).toContain('How should this test stack run?');
    expect(out).toContain('MODE=prod');
  });

  it('plyr rejects --token with --dev before touching Docker', () => {
    const r = spawnSync(path.join(root, 'plyr'), ['dev-docker', '--dev', '--token', 'new'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain('--token only applies to --prod');
  });

  it('the dev compose file reads the answers and is still loopback-only', () => {
    const compose = fs.readFileSync(path.join(root, 'docker-compose.dev.yml'), 'utf8');
    expect(compose).toContain('${PLYR_DEV_API_TOKEN:-admin123}');
    expect(compose).toContain('${PLYR_DEV_AUTH_MODE:-open}');
    expect(compose).toContain('127.0.0.1:3000:3000');
    const manager = fs.readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    expect(manager).toContain('--env-file "$DEV_ENV_FILE"');
    // The questions come before the slow pull/build.
    const body = manager.slice(manager.indexOf('\ndev_docker() {'));
    expect(body.indexOf('dev_docker_setup')).toBeLessThan(body.indexOf('dev_docker_pull_prebuilt "$source"'));
  });

  it('keeps shell scripts LF in a Windows checkout', () => {
    const attrs = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
    expect(attrs).toMatch(/^\*\.sh\s+text eol=lf$/m);
    expect(attrs).toMatch(/^plyr\s+text eol=lf$/m);
  });
});


describe('wz_gen_token (Windows / Git Bash regressions)', () => {
  const hasEnv = process.platform === 'linux';
  /** Run `wz_gen_token` under `set -Eeuo pipefail` with SIGPIPE at its default, like a real terminal. */
  function gen(pathPrefix: string, pathOnly = false): { status: number | null; out: string } {
    const file = path.join(dir, 'gen.sh');
    fs.writeFileSync(file, `set -Eeuo pipefail\nsource ${wizard}\nfor i in 1 2 3 4 5; do t="$(wz_gen_token)"; done\nprintf '%s' "$t"\n`);
    const PATH = pathOnly ? pathPrefix : `${pathPrefix}:${process.env.PATH}`;
    const r = spawnSync('env', ['--default-signal=PIPE', 'bash', file], { encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH } });
    return { status: r.status, out: r.stdout };
  }

  it.skipIf(!hasEnv)('survives a slow openssl that appends CRLF (native Windows build)', () => {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'openssl'), '#!/usr/bin/env bash\nprintf %s 6f9c4b332369002ad9d156fd60f87c630a29bc5d148e4873; sleep 0.1; printf "\\r\\n"\n', { mode: 0o755 });
    const r = gen(bin);
    expect(r.status).toBe(0);
    expect(r.out).toBe('6f9c4b332369002ad9d156fd60f87c630a29bc5d148e4873');
  });

  it.skipIf(!hasEnv)('still returns 48 hex characters when openssl does not exist', () => {
    const bin = path.join(dir, 'bin2'); fs.mkdirSync(bin);
    for (const c of ['bash', 'od', 'tr', 'date', 'sed', 'grep', 'cut', 'tail', 'awk', 'mv', 'chmod', 'mkdir', 'cat', 'printf', 'dirname', 'env']) {
      const w = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' }).stdout.trim();
      if (w) fs.symlinkSync(w, path.join(bin, c));
    }
    const r = gen(bin, true);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/^[0-9a-f]{48}$/);
  });

  it('plyr.sh reuses wz_gen_token instead of its own head-pipe, and reports unexpected failures', () => {
    const manager = fs.readFileSync(path.join(root, 'scripts/plyr.sh'), 'utf8');
    expect(manager).toContain('fresh_token="$(wz_gen_token)"');
    expect(manager).not.toMatch(/\| head -c 48\)/);
    expect(manager).toMatch(/trap .*ERR/);
  });
});

describe('./plyr dev-docker --ref works from any checkout, with no git commands first', () => {
  const ok = process.platform === 'linux' && hasScript;
  const sh = (cmd: string, cwd: string, extra: NodeJS.ProcessEnv = {}) =>
    spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...extra } });

  it.skipIf(!ok)('uses the compose file and scripts of the ref, and leaves the user\'s checkout alone', () => {
    // origin: has an "old" commit (no ALLOW_OPEN_AUTH) and a PR ref whose files are newer.
    const origin = path.join(dir, 'origin.git'); const user = path.join(dir, 'user');
    const w = path.join(dir, 'work'); fs.mkdirSync(w);
    sh(`git init -q -b main . && git config user.email t@t && git config user.name t`, w);
    fs.mkdirSync(path.join(w, 'scripts'), { recursive: true });
    for (const f of ['scripts/plyr.sh', 'scripts/setup-wizard.sh', 'plyr']) {
      fs.mkdirSync(path.dirname(path.join(w, f)), { recursive: true });
      fs.copyFileSync(path.join(root, f), path.join(w, f));
    }
    fs.writeFileSync(path.join(w, 'docker-compose.dev.yml'), 'services: {}\n# OLD\n');
    sh('git add -A && git commit -qm old', w);
    fs.writeFileSync(path.join(w, 'docker-compose.dev.yml'), 'services: {}\n# NEW-FROM-PR\n');
    sh('git add -A && git commit -qm new', w);
    const prSha = sh('git rev-parse HEAD', w).stdout.trim();
    sh(`git clone -q --bare . ${origin} && git -C ${origin} update-ref refs/pull/7/head ${prSha}`, w);
    sh(`git clone -q ${origin} ${user} && git -C ${user} reset -q --hard HEAD~1`, dir);   // user is one commit behind
    expect(fs.readFileSync(path.join(user, 'docker-compose.dev.yml'), 'utf8')).toContain('OLD');

    const bin = path.join(dir, 'fakebin'); fs.mkdirSync(bin);
    const log = path.join(dir, 'docker.log');
    fs.writeFileSync(path.join(bin, 'docker'),
      `#!/usr/bin/env bash\necho "docker $*" >> ${log}\ncase "$1" in version) echo amd64;; esac\nexit 0\n`, { mode: 0o755 });
    const r = sh('./plyr dev-docker --ref pr-7 --dev; echo RC=$?', user,
      { PATH: `${bin}:${process.env.PATH}`, PLYR_DEV_IMAGE_REPO: 'ghcr.io/o/r', AB_NO_PROMPT: '1' });
    const out = `${r.stdout}${r.stderr}`;
    expect(out).toContain('RC=0');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain(`docker pull ghcr.io/o/r:${prSha}`);
    // compose ran with the PR's file, not the stale one in the user's checkout
    const used = /--file (\S+)/.exec(calls)![1];
    expect(used).toContain(`.plyr/ref/${prSha.slice(0, 12)}`);
    expect(fs.readFileSync(used, 'utf8')).toContain('NEW-FROM-PR');
    // the user's branch and files were not touched
    expect(sh('git status --porcelain --untracked-files=no && git rev-parse --abbrev-ref HEAD', user).stdout.trim()).toBe('main');
    expect(fs.readFileSync(path.join(user, 'docker-compose.dev.yml'), 'utf8')).toContain('OLD');
  });
});
