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

