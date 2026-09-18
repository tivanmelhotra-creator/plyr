import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const cli = path.join(root, 'plyr');
const enabled = process.env.RUN_PLYR_PERSISTENCE_E2E === '1';

function run(args: string[], env: Record<string, string>): string {
  return execFileSync(cli, args, {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function redis(args: string[], port: number): string {
  return execFileSync('redis-cli', ['-h', '127.0.0.1', '-p', String(port), ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

function freePort(port: number): void {
  try {
    const listeners = execFileSync('sh', ['-c', `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`], {
      encoding: 'utf8',
    });
    const pids = [...listeners.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    for (const pid of new Set(pids)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const stillListening = execFileSync('sh', ['-c', `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`], {
          encoding: 'utf8',
        });
        if (!/pid=\d+/.test(stillListening)) return;
        execFileSync('sleep', ['0.1']);
      } catch {
        return;
      }
    }
    try {
      const remaining = execFileSync('sh', ['-c', `ss -ltnp '( sport = :${port} )' 2>/dev/null || true`], {
        encoding: 'utf8',
      });
      for (const match of remaining.matchAll(/pid=(\d+)/g)) {
        try { process.kill(Number(match[1]), 'SIGKILL'); } catch { /* already gone */ }
      }
    } catch { /* best-effort */ }
  } catch {
    // Cleanup is best-effort; the assertion failure should remain the signal.
  }
}

async function getWorkflows(port: number): Promise<{ success: boolean; workflows?: Array<{ id: string }> }> {
  const response = await fetch(`http://127.0.0.1:${port}/workflows/local`, {
    headers: { 'x-api-key': 'admin123' },
  });
  return response.json() as Promise<{ success: boolean; workflows?: Array<{ id: string }> }>;
}

describe.skipIf(!enabled)('Plyr Redis persistence', () => {
  it('persists a real workflow and its workspace across stop/start', async () => {
    const testRoot = mkdtempSync(path.join(root, '.plyr-persistence-test-'));
    const stateDir = path.join(testRoot, 'state');
    const storageRoot = path.join(testRoot, 'workflow-files');
    const envFile = path.join(testRoot, '.env');
    const port = 35000 + (process.pid % 1000);
    const redisPort = 36000 + (process.pid % 1000);
    const env = {
      PLYR_STATE_DIR: stateDir,
      PLYR_ENV_FILE: envFile,
    };
    const runtimeEnv = {
      ...env,
      PORT: String(port),
      REDIS_URL: `redis://127.0.0.1:${redisPort}`,
      WORKFLOW_STORAGE_ROOT: storageRoot,
      API_TOKEN: 'admin123',
      REAL_CHROME_HEADLESS: 'true',
    };

    mkdirSync(stateDir, { recursive: true });
    writeFileSync(envFile, [
      `PORT=${port}`,
      `REDIS_URL=redis://127.0.0.1:${redisPort}`,
      `WORKFLOW_STORAGE_ROOT=${storageRoot}`,
      'API_TOKEN=admin123',
      'API_KEYS_ENABLED=false',
      'REAL_CHROME_HEADLESS=true',
      '',
    ].join('\n'));

    let workflowId = '';
    try {
      run(['start', '--dev'], runtimeEnv);
      const created = await fetch(`http://127.0.0.1:${port}/workflows/local`, {
        method: 'POST',
        headers: { 'x-api-key': 'admin123', 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Plyr Redis Persistence Regression',
          steps: [{ action: 'trigger_manual', params: {} }],
          headless: true,
        }),
      });
      expect(created.status).toBe(201);
      const createdBody = await created.json() as { workflow: { id: string } };
      workflowId = createdBody.workflow.id;

      expect(redis(['EXISTS', `wf:meta:local:${workflowId}`], redisPort)).toBe('1');
      const workspace = path.join(storageRoot, 'local', workflowId);
      expect(existsSync(workspace)).toBe(true);
      expect(existsSync(path.join(workspace, 'uploads'))).toBe(true);
      expect(existsSync(path.join(workspace, 'downloads'))).toBe(true);

      const lastSaveBefore = Number(redis(['LASTSAVE'], redisPort));
      expect(Number.isFinite(lastSaveBefore)).toBe(true);

      run(['stop'], runtimeEnv);
      freePort(port);

      const dump = path.join(root, 'dump.rdb');
      expect(existsSync(dump)).toBe(true);
      expect(statSync(dump).size).toBeGreaterThan(0);

      run(['start', '--dev'], runtimeEnv);
      const listed = await getWorkflows(port);
      expect(listed.success).toBe(true);
      expect(listed.workflows?.some((workflow) => workflow.id === workflowId)).toBe(true);
      expect(redis(['EXISTS', `wf:meta:local:${workflowId}`], redisPort)).toBe('1');
      expect(existsSync(path.join(storageRoot, 'local', workflowId, 'uploads'))).toBe(true);
      expect(existsSync(path.join(storageRoot, 'local', workflowId, 'downloads'))).toBe(true);
    } finally {
      try { run(['stop'], runtimeEnv); } catch { /* runtime may already be down */ }
      freePort(port);
      try { redis(['shutdown', 'nosave'], redisPort); } catch { /* already down */ }
      rmSync(testRoot, { recursive: true, force: true });
    }
  }, 120_000);
});
