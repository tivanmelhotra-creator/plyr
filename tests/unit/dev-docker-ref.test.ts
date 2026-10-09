/**
 * dev-docker-ref.test.ts — `./plyr dev-docker --ref pr-N` must be ONE command
 * from any checkout (no `git fetch` / `git checkout` first). The scripts and
 * docker-compose.dev.yml that start the image must come from the ref itself.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const root = path.resolve(__dirname, '../..');
const ok = process.platform === 'linux';
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-ref-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const sh = (cmd: string, cwd: string, extra: NodeJS.ProcessEnv = {}) =>
  spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...extra } });

describe('./plyr dev-docker --ref', () => {
  it.skipIf(!ok)('runs the ref\'s own compose file and leaves the user\'s checkout alone', () => {
    const origin = path.join(dir, 'origin.git'); const user = path.join(dir, 'user'); const w = path.join(dir, 'work');
    fs.mkdirSync(w);
    sh('git init -q -b main . && git config user.email t@t && git config user.name t', w);
    for (const f of ['scripts/plyr.sh', 'scripts/setup-wizard.sh', 'plyr']) {
      if (!fs.existsSync(path.join(root, f))) continue;
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
    const r = sh('./plyr dev-docker --ref pr-7; echo RC=$?', user,
      { PATH: `${bin}:${process.env.PATH}`, PLYR_DEV_IMAGE_REPO: 'ghcr.io/o/r', AB_NO_PROMPT: '1' });
    expect(`${r.stdout}${r.stderr}`).toContain('RC=0');
    const calls = fs.readFileSync(log, 'utf8');
    expect(calls).toContain(`docker pull ghcr.io/o/r:${prSha}`);
    const used = /--file (\S+)/.exec(calls)![1];
    expect(used).toContain(`.plyr/ref/${prSha.slice(0, 12)}`);
    expect(fs.readFileSync(used, 'utf8')).toContain('NEW-FROM-PR');
    // the user's branch and files were not touched
    expect(sh('git rev-parse --abbrev-ref HEAD && git status --porcelain --untracked-files=no', user).stdout.trim()).toBe('main');
    expect(fs.readFileSync(path.join(user, 'docker-compose.dev.yml'), 'utf8')).toContain('OLD');
  });
});
