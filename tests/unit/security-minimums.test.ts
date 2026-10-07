/**
 * Task 6 — security minimums.
 *
 * Every rule in src/core/SecurityChecks.ts is exercised with real inputs: real
 * compose text, a real SQLite file, a real TCP listener for the Redis probe.
 * Nothing is mocked except the NIC list and the TLS handshake (no network in CI).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  isLoopbackBind, isWildcardBind, scanComposeForRedisExposure, scanComposeDir,
  parseRedisUrl, scanWorkflowRecords, scanSqliteWorkflows, runSecurityChecks,
  runHttpsProbe, probeTcp, DEFAULT_LIVE_SHARE_TTL_SEC,
  type SecurityInputs,
} from '../../src/core/SecurityChecks';

const REPO = path.resolve(__dirname, '..', '..');

const base = (over: Partial<SecurityInputs> = {}): SecurityInputs => ({
  profile: 'server',
  debugBind: '127.0.0.1',
  chromeEnabled: true,
  redisUrl: 'redis://127.0.0.1:6379',
  publicDomain: '',
  webhookSecret: '',
  storageDriver: 'sqlite',
  sqlitePath: '/nonexistent/plyr.db',
  liveShareTtlSec: DEFAULT_LIVE_SHARE_TTL_SEC,
  webhookScan: { scanned: true, openTriggers: [], outgoing: [] },
  ...over,
});
const ids = (r: { issues: { id: string }[] }) => r.issues.map((i) => i.id);

describe('REAL_CHROME_DEBUG_BIND', () => {
  it('classifies loopback vs wildcard', () => {
    for (const b of ['', '127.0.0.1', 'localhost', '::1', '127.0.0.5']) expect(isLoopbackBind(b), b).toBe(true);
    for (const b of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.2']) expect(isLoopbackBind(b), b).toBe(false);
    expect(isWildcardBind('0.0.0.0')).toBe(true);
    expect(isWildcardBind('127.0.0.1')).toBe(false);
  });

  it('is silent on the default 127.0.0.1', async () => {
    expect(ids(await runSecurityChecks(base()))).not.toContain('debug_bind_exposed');
  });

  it('warns on 0.0.0.0 and says what it exposes and how to fix it', async () => {
    const r = await runSecurityChecks(base({ debugBind: '0.0.0.0' }));
    const issue = r.issues.find((i) => i.id === 'debug_bind_exposed')!;
    expect(issue.severity).toBe('warn');
    expect(issue.problem).toMatch(/EVERY network interface/);
    expect(issue.problem).toMatch(/cookie/);
    expect(issue.fix).toMatch(/127\.0\.0\.1/);
  });

  it('is skipped when the Remote Browser is disabled', async () => {
    const r = await runSecurityChecks(base({ debugBind: '0.0.0.0', chromeEnabled: false }));
    expect(ids(r)).not.toContain('debug_bind_exposed');
  });

  it('the shipped default (config.ts + .env.example) is loopback', () => {
    const example = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    expect(example).toMatch(/^REAL_CHROME_DEBUG_BIND=127\.0\.0\.1\r?$/m);
    const cfg = fs.readFileSync(path.join(REPO, 'src/config.ts'), 'utf8');
    expect(cfg).toMatch(/REAL_CHROME_DEBUG_BIND:[^\n]*\|\| '127\.0\.0\.1'/);
  });
});

describe('Redis exposure — compose files', () => {
  const compose = (ports: string) => `services:
  redis:
    image: redis:7-alpine
${ports}
  app:
    ports:
      - "3000:3000"
`;

  it('finds a published 6379', () => {
    const hits = scanComposeForRedisExposure(compose('    ports:\n      - "6379:6379"'), 'x.yml');
    expect(hits).toEqual([{ file: 'x.yml', mapping: '6379:6379' }]);
  });

  it('finds 0.0.0.0 and short forms, ignores loopback-bound and commented ports', () => {
    expect(scanComposeForRedisExposure(compose('    ports:\n      - 0.0.0.0:6380:6379')).length).toBe(1);
    expect(scanComposeForRedisExposure(compose('    ports:\n      - "6379"')).length).toBe(1);
    expect(scanComposeForRedisExposure(compose('    ports:\n      - "127.0.0.1:6379:6379"')).length).toBe(0);
    expect(scanComposeForRedisExposure(compose('    # ports:\n    #   - "6379:6379"')).length).toBe(0);
  });

  it('does not confuse the app service (3000) with redis', () => {
    expect(scanComposeForRedisExposure(compose('')).length).toBe(0);
  });

  it('every compose file SHIPPED in this repo keeps Redis private', () => {
    const { scanned, exposed } = scanComposeDir(REPO);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expect(exposed).toEqual([]);
  });

  it('warns (fix: delete ports / bind 127.0.0.1) when a directory publishes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-sec-'));
    fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose('    ports:\n      - "6379:6379"'));
    const r = await runSecurityChecks(base({ composeDir: dir }));
    const issue = r.issues.find((i) => i.id === 'redis_port_exposed')!;
    expect(issue.severity).toBe('warn');
    expect(issue.problem).toMatch(/docker-compose\.yml/);
    expect(issue.fix).toMatch(/127\.0\.0\.1:6379:6379/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Redis exposure — live probe', () => {
  const servers: net.Server[] = [];
  afterEach(() => { for (const s of servers.splice(0)) s.close(); });

  const listen = (host: string, reply: string): Promise<number> => new Promise((resolve) => {
    const s = net.createServer((sock) => { sock.on('data', () => sock.write(reply)); });
    servers.push(s);
    s.listen(0, host, () => resolve((s.address() as net.AddressInfo).port));
  });

  it('parses REDIS_URL', () => {
    expect(parseRedisUrl('redis://redis:6379')).toEqual({ host: 'redis', port: 6379, hasPassword: false, tls: false });
    expect(parseRedisUrl('rediss://:pw@10.0.0.2:6380/1')).toMatchObject({ host: '10.0.0.2', port: 6380, hasPassword: true, tls: true });
    expect(parseRedisUrl('nonsense')).toBeNull();
  });

  it('probeTcp tells a PONG, a NOAUTH and a closed port apart', async () => {
    const pong = await listen('127.0.0.1', '+PONG\r\n');
    const noauth = await listen('127.0.0.1', '-NOAUTH Authentication required.\r\n');
    expect(await probeTcp('127.0.0.1', pong)).toEqual({ reachable: true, answer: 'pong' });
    expect(await probeTcp('127.0.0.1', noauth)).toEqual({ reachable: true, answer: 'noauth' });
    const closed = await new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
    expect((await probeTcp('127.0.0.1', closed)).reachable).toBe(false);
  });

  it('warns when Redis answers on a non-loopback address of this host', async () => {
    const port = await listen('127.0.0.1', '+PONG\r\n');
    const r = await runSecurityChecks(base({
      redisUrl: `redis://127.0.0.1:${port}`,
      // pretend this host has an external address; the probe maps it to loopback
      interfaces: { eth0: [{ address: '203.0.113.9', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] },
      probe: (_h, p) => probeTcp('127.0.0.1', p),
    }));
    const issue = r.issues.find((i) => i.id === 'redis_port_exposed')!;
    expect(issue.problem).toMatch(/203\.0\.113\.9/);
    expect(issue.problem).toMatch(/PING without a password/);
  });

  it('is clean when nothing answers on the external address', async () => {
    const r = await runSecurityChecks(base({
      interfaces: { eth0: [{ address: '203.0.113.9', family: 'IPv4', internal: false } as os.NetworkInterfaceInfo] },
      probe: async () => ({ reachable: false, answer: 'none' }),
    }));
    expect(ids(r)).not.toContain('redis_port_exposed');
    expect(r.checks.find((c) => c.id === 'redis_exposed')!.state).toBe('ok');
  });

  it('does not probe a Redis that lives elsewhere (docker service name)', async () => {
    let probed = 0;
    await runSecurityChecks(base({
      redisUrl: 'redis://redis:6379',
      probe: async () => { probed++; return { reachable: true, answer: 'pong' }; },
    }));
    expect(probed).toBe(0);
  });
});

describe('HTTPS when a domain is set', () => {
  it('warns on plain http for a public host', async () => {
    const r = await runSecurityChecks(base({ publicDomain: 'http://plyr.example.com' }));
    const issue = r.issues.find((i) => i.id === 'public_domain_not_https')!;
    expect(issue.fix).toMatch(/Caddy/);
  });

  it('accepts https, and http on localhost; skips when unset', async () => {
    expect(ids(await runSecurityChecks(base({ publicDomain: 'https://plyr.example.com' })))).not.toContain('public_domain_not_https');
    expect(ids(await runSecurityChecks(base({ publicDomain: 'http://localhost:3000' })))).not.toContain('public_domain_not_https');
    expect((await runSecurityChecks(base())).checks.find((c) => c.id === 'https')!.state).toBe('skipped');
  });

  it('a bare domain is treated as https (like PublicBaseUrl does)', async () => {
    expect(ids(await runSecurityChecks(base({ publicDomain: 'plyr.example.com' })))).not.toContain('public_domain_not_https');
  });

  it('doctor probe: warns when TLS does not answer, passes when it does, skips http/local', async () => {
    const bad = await runHttpsProbe('https://plyr.example.com', async () => ({ ok: false, detail: 'ECONNREFUSED' }));
    expect(bad.issues[0]!.id).toBe('https_unreachable');
    expect(bad.issues[0]!.fix).toMatch(/Caddy/);
    const good = await runHttpsProbe('https://plyr.example.com', async () => ({ ok: true, detail: 'valid certificate, 60 day(s) left' }));
    expect(good.issues).toEqual([]);
    expect(good.checks[0]!.state).toBe('ok');
    let called = 0;
    const probe = async () => { called++; return { ok: true, detail: '' }; };
    await runHttpsProbe('http://plyr.example.com', probe);
    await runHttpsProbe('https://localhost', probe);
    await runHttpsProbe('', probe);
    expect(called).toBe(0);
  });
});

describe('webhook without HMAC', () => {
  const wf = (over: Record<string, unknown>) => ({ name: 'W', active: true, steps: [], ...over });

  it('flags an ACTIVE workflow whose webhook trigger has no secret', () => {
    const r = scanWorkflowRecords([
      wf({ name: 'open', steps: [{ action: 'trigger_webhook', params: { path: 'x' } }, { action: 'goto', params: {} }] }),
      wf({ name: 'signed', steps: [{ action: 'trigger_webhook', params: { secret: 's3cret' } }] }),
      wf({ name: 'inactive', active: false, steps: [{ action: 'trigger_webhook', params: {} }] }),
      wf({ name: 'nested', steps: [{ action: 'if', params: {}, branches: [[{ action: 'trigger_webhook', params: { secret: '  ' } }]] }] }),
    ]);
    expect(r.openTriggers.sort()).toEqual(['nested', 'open']);
  });

  it('lists workflows with an outgoing webhookUrl', () => {
    expect(scanWorkflowRecords([wf({ name: 'out', webhookUrl: 'https://x.test/h' })]).outgoing).toEqual(['out']);
  });

  it('warns on a reachable instance, with the field to fill in', async () => {
    const r = await runSecurityChecks(base({
      webhookScan: { scanned: true, openTriggers: ['open'], outgoing: ['out'] },
    }));
    const issue = r.issues.find((i) => i.id === 'webhook_without_hmac')!;
    expect(issue.problem).toMatch(/open/);
    expect(issue.problem).toMatch(/WEBHOOK_SECRET is empty/);
    expect(issue.fix).toMatch(/secret/);
  });

  it('is quiet when WEBHOOK_SECRET signs outgoing hooks and triggers have secrets', async () => {
    const r = await runSecurityChecks(base({
      webhookSecret: 'abc', webhookScan: { scanned: true, openTriggers: [], outgoing: ['out'] },
    }));
    expect(ids(r)).not.toContain('webhook_without_hmac');
  });

  it('is skipped on a local-only profile', async () => {
    const r = await runSecurityChecks(base({
      profile: 'development', webhookScan: { scanned: true, openTriggers: ['open'], outgoing: [] },
    }));
    expect(ids(r)).not.toContain('webhook_without_hmac');
  });

  it('reads the real SQLite file read-only and never creates one', () => {
    expect(scanSqliteWorkflows('/nonexistent/dir/plyr.db').scanned).toBe(false);
    expect(fs.existsSync('/nonexistent/dir/plyr.db')).toBe(false);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-sec-'));
    const file = path.join(dir, 'plyr.db');
    const db = new Database(file);
    db.exec('CREATE TABLE workflows (user_id TEXT, id TEXT, version INTEGER, updated_at TEXT, data TEXT)');
    const ins = db.prepare('INSERT INTO workflows VALUES (?,?,?,?,?)');
    ins.run('u', '1', 1, 'now', JSON.stringify({ name: 'hook', active: true, steps: [{ action: 'trigger_webhook', params: {} }] }));
    ins.run('u', '2', 1, 'now', JSON.stringify({ name: 'ok', active: true, steps: [{ action: 'goto', params: {} }] }));
    db.close();
    const scan = scanSqliteWorkflows(file);
    expect(scan).toMatchObject({ scanned: true, openTriggers: ['hook'] });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('LIVE_SHARE_TTL_SEC', () => {
  it('default is 2 h, in config, .env.example and the token minter', () => {
    expect(DEFAULT_LIVE_SHARE_TTL_SEC).toBe(7200);
    const example = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8');
    expect(example).toMatch(/^LIVE_SHARE_TTL_SEC=7200\r?$/m);
    expect(fs.readFileSync(path.join(REPO, 'src/config.ts'), 'utf8')).toMatch(/intNow\('LIVE_SHARE_TTL_SEC', 7200,/);
  });

  it('is longer than the longest default run, so a link never dies mid-run', () => {
    // MAX_JOB_DURATION_MINUTES defaults to 90.
    expect(DEFAULT_LIVE_SHARE_TTL_SEC).toBeGreaterThan(90 * 60);
  });

  it('warns on 0 (never) and on more than a day, not on the default', async () => {
    expect(ids(await runSecurityChecks(base({ liveShareTtlSec: 0 })))).toContain('live_share_ttl');
    expect(ids(await runSecurityChecks(base({ liveShareTtlSec: 7 * 86400 })))).toContain('live_share_ttl');
    expect(ids(await runSecurityChecks(base({ liveShareTtlSec: 7200 })))).not.toContain('live_share_ttl');
  });
});

describe('dev-only admin123 — repository wiring', () => {
  const read = (p: string) => fs.readFileSync(path.join(REPO, p), 'utf8');

  it('admin123 as a compose value appears ONLY in docker-compose.dev.yml, with the opt-out beside it', () => {
    const files = fs.readdirSync(REPO).filter((n) => /^docker-compose.*\.ya?ml$/.test(n));
    for (const f of files) {
      const text = read(f);
      // Literal, or as the bare-compose fallback of ./plyr dev-docker's own token.
      const sets = /^\s*API_TOKEN:\s*(admin123|\$\{PLYR_DEV_API_TOKEN:-admin123\})/m.test(text);
      if (f === 'docker-compose.dev.yml') {
        expect(sets).toBe(true);
        expect(text).toMatch(/ALLOW_DEFAULT_API_TOKEN:\s*"true"/);
        expect(text).toMatch(/127\.0\.0\.1:3000:3000/);
      } else {
        expect(sets, f).toBe(false);
        expect(text, f).not.toMatch(/ALLOW_DEFAULT_API_TOKEN:\s*"?true/);
        // Login without a token is allowed only on the loopback-only dev stack.
        expect(text, f).not.toMatch(/ALLOW_OPEN_AUTH:\s*"?true/);
        expect(text, f).not.toMatch(/AUTH_MODE:\s*"?open/);
      }
    }
  });

  it('a fresh .env made by ./plyr gets a random token instead of admin123', () => {
    const sh = read('scripts/plyr.sh');
    expect(sh).toMatch(/openssl rand -hex 24/);
    expect(sh).toMatch(/s\|\^API_TOKEN=admin123/);
  });

  it('doctor prints the security section from the same checks the boot uses', () => {
    const doctor = read('src/cli/doctor.ts');
    expect(doctor).toMatch(/SECURITY MINIMUMS/);
    expect(doctor).toMatch(/collectSecurity\(\)/);
    expect(doctor).toMatch(/runHttpsProbe\(/);
    expect(read('src/core/StartupValidation.ts')).toMatch(/await collectSecurity\(\)/);
  });
});
