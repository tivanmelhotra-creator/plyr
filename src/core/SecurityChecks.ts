/**
 * SecurityChecks — the "security minimums" the operator is told about at boot
 * and by `npm run doctor`.
 *
 * Everything here is a PURE function of (config values, files, an injectable
 * network probe), so each rule is unit-tested without opening a real port.
 * `validateStartup()` turns the result into ValidationIssue rows; `doctor`
 * prints the same rows plus a per-check ✓/⚠ list.
 *
 * What is checked, and why each one is only a `warn` unless said otherwise:
 *
 *   debug_bind_exposed     REAL_CHROME_DEBUG_BIND is not loopback. Chrome's
 *                          DevTools port is remote code execution + full cookie
 *                          theft for whoever can reach it.
 *   default_token_*        (decided in StartupValidation) admin123 under a
 *                          server/production profile.
 *   redis_port_exposed     Redis answers on a non-loopback address of this
 *                          host, or a compose file publishes 6379 to the world.
 *                          Redis is the job queue: write access == run code.
 *   public_domain_not_https PUBLIC_DOMAIN is plain http on a public host: the
 *                          API token and cookies travel in clear text.
 *   https_unreachable      (doctor only) nothing valid answers TLS on the
 *                          domain, i.e. the reverse proxy (Caddy) is not doing
 *                          its job.
 *   webhook_without_hmac   an ACTIVE workflow has a webhook trigger without a
 *                          secret, or outgoing webhooks are unsigned
 *                          (WEBHOOK_SECRET empty), on a reachable instance.
 *   live_share_ttl         share links never expire / live for more than a day.
 *
 * Nothing here writes anything. The workflow scan opens SQLite READ-ONLY and
 * never creates the file.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { isLoopbackHost, normalizeConfiguredDomain } from './PublicBaseUrl';
import { DEFAULT_SHARE_TTL_SEC } from './StepReporter';
import type { ValidationIssue } from './StartupValidation';

/** Default share-link lifetime (2 h) — single source: StepReporter. */
export const DEFAULT_LIVE_SHARE_TTL_SEC = DEFAULT_SHARE_TTL_SEC;
/** Above this a share link is a standing credential rather than a viewing aid. */
export const LONG_LIVE_SHARE_TTL_SEC = 24 * 60 * 60;

export type CheckState = 'ok' | 'warn' | 'skipped';
export interface CheckLine {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface SecurityReport {
  issues: ValidationIssue[];
  checks: CheckLine[];
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** `''` and every loopback spelling count as "this machine only". */
export function isLoopbackBind(bind: string | undefined | null): boolean {
  const b = (bind || '').trim();
  if (!b) return true; // RealChrome falls back to 127.0.0.1
  // isLoopbackHost() also answers true for 0.0.0.0 ("means nothing to a remote
  // caller" is its question), but as a LISTEN address 0.0.0.0 is the opposite:
  // every interface. Exclude the wildcard explicitly.
  if (isWildcardBind(b)) return false;
  return isLoopbackHost(b);
}

export function isWildcardBind(bind: string | undefined | null): boolean {
  const b = (bind || '').trim().toLowerCase();
  return b === '0.0.0.0' || b === '::' || b === '[::]' || b === '*';
}

export interface ComposeRedisExposure {
  file: string;
  mapping: string;
}

/**
 * Find published Redis ports in one compose file's text.
 *
 * A tiny indentation-based reader instead of a YAML dependency: it only needs
 * the `redis:` service's uncommented `ports:` list. A mapping is "exposed"
 * unless it is explicitly bound to loopback (`127.0.0.1:` / `[::1]:` /
 * `localhost:`). Only mappings whose CONTAINER port is 6379 are reported.
 */
export function scanComposeForRedisExposure(text: string, file = 'compose'): ComposeRedisExposure[] {
  const lines = text.replace(/\r/g, '').split('\n');
  const found: ComposeRedisExposure[] = [];
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const isBlank = (l: string) => l.trim() === '' || l.trim().startsWith('#');

  let servicesIndent = -1;
  let serviceIndent = -1;
  let inRedis = false;
  let redisIndent = -1;
  let inPorts = false;
  let portsIndent = -1;

  for (const raw of lines) {
    if (isBlank(raw)) continue;
    const ind = indentOf(raw);
    const t = raw.trim();

    if (servicesIndent < 0) {
      if (/^services:\s*$/.test(t) && ind === 0) servicesIndent = ind;
      continue;
    }
    if (ind <= servicesIndent) { servicesIndent = -1; inRedis = false; inPorts = false; continue; }
    if (serviceIndent < 0) serviceIndent = ind;

    if (ind === serviceIndent) {
      const name = t.replace(/:\s*$/, '');
      inRedis = /:\s*$/.test(t) && /(^|[-_])redis([-_]|$)/i.test(name);
      redisIndent = ind;
      inPorts = false;
      continue;
    }
    if (!inRedis || ind <= redisIndent) continue;

    if (/^ports:\s*$/.test(t)) { inPorts = true; portsIndent = ind; continue; }
    if (inPorts) {
      if (ind <= portsIndent) { inPorts = false; continue; }
      const m = /^-\s*(.+?)\s*$/.exec(t);
      if (!m) continue;
      const mapping = m[1]!.replace(/^["']|["']$/g, '').replace(/\s+#.*$/, '');
      const body = mapping.replace(/\/(tcp|udp)$/i, '');
      const parts = body.split(':');
      const container = parts[parts.length - 1];
      if (container !== '6379') continue;
      const loopbackBound = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]):/.test(body);
      if (!loopbackBound) found.push({ file, mapping });
    }
  }
  return found;
}

/** Read `docker-compose*.yml` in `dir`; missing/unreadable files are skipped. */
export function scanComposeDir(dir: string): { scanned: string[]; exposed: ComposeRedisExposure[] } {
  const scanned: string[] = [];
  const exposed: ComposeRedisExposure[] = [];
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { scanned, exposed }; }
  for (const name of names.filter((n) => /^docker-compose.*\.ya?ml$/i.test(n)).sort()) {
    try {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      scanned.push(name);
      exposed.push(...scanComposeForRedisExposure(text, name));
    } catch { /* unreadable: skip, this is advice not a gate */ }
  }
  return { scanned, exposed };
}

export interface RedisTarget { host: string; port: number; hasPassword: boolean; tls: boolean }

export function parseRedisUrl(raw: string): RedisTarget | null {
  try {
    const u = new URL(raw);
    if (!/^rediss?:$/.test(u.protocol)) return null;
    return {
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port ? parseInt(u.port, 10) : 6379,
      hasPassword: !!u.password,
      tls: u.protocol === 'rediss:',
    };
  } catch { return null; }
}

/** Non-loopback IPv4 addresses of this machine. */
export function localExternalAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const i of list || []) {
      if (!i.internal && i.family === 'IPv4') out.push(i.address);
    }
  }
  return out;
}

/** Result of poking a TCP port. `answer` is what a Redis would say to PING. */
export interface TcpProbeResult { reachable: boolean; answer: 'pong' | 'noauth' | 'other' | 'none' }
export type TcpProbe = (host: string, port: number) => Promise<TcpProbeResult>;

/** Real probe: connect, send PING, classify the first reply. 500 ms budget. */
export const probeTcp: TcpProbe = (host, port) => new Promise((resolve) => {
  let done = false;
  const finish = (r: TcpProbeResult) => { if (!done) { done = true; try { sock.destroy(); } catch { /* */ } resolve(r); } };
  const sock = net.connect({ host, port });
  const timer = setTimeout(() => finish({ reachable: sock.connecting ? false : true, answer: 'none' }), 500);
  sock.once('connect', () => { sock.write('PING\r\n'); });
  sock.once('data', (buf) => {
    clearTimeout(timer);
    const s = buf.toString('utf8');
    finish({ reachable: true, answer: s.startsWith('+PONG') ? 'pong' : /^-NOAUTH|^-ERR.*auth/i.test(s) ? 'noauth' : 'other' });
  });
  sock.once('error', () => { clearTimeout(timer); finish({ reachable: false, answer: 'none' }); });
});

// ── Workflow scan (webhook triggers without a secret) ───────────────────────

export interface WebhookScan {
  scanned: boolean;
  reason?: string;
  openTriggers: string[];     // active workflows with a trigger_webhook and no secret
  outgoing: string[];         // workflows with a webhookUrl
}

function walkForWebhookTriggers(node: unknown, hits: { secret: boolean }[], depth = 0): void {
  if (depth > 12 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walkForWebhookTriggers(n, hits, depth + 1); return; }
  const o = node as Record<string, unknown>;
  const action = typeof o.action === 'string' ? o.action : typeof o.id === 'string' ? o.id : '';
  if (action === 'trigger_webhook' || action === 'webhook_trigger') {
    const params = (o.params && typeof o.params === 'object' ? o.params : o) as Record<string, unknown>;
    hits.push({ secret: typeof params.secret === 'string' && params.secret.trim() !== '' });
  }
  for (const v of Object.values(o)) walkForWebhookTriggers(v, hits, depth + 1);
}

/** Pure: classify already-loaded workflow records. */
export function scanWorkflowRecords(records: unknown[]): Pick<WebhookScan, 'openTriggers' | 'outgoing'> {
  const openTriggers: string[] = [];
  const outgoing: string[] = [];
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    const wf = rec as { name?: unknown; active?: unknown; steps?: unknown; webhookUrl?: unknown };
    const label = typeof wf.name === 'string' && wf.name ? wf.name : '(unnamed)';
    if (typeof wf.webhookUrl === 'string' && wf.webhookUrl) outgoing.push(label);
    if (wf.active !== true) continue;
    const hits: { secret: boolean }[] = [];
    walkForWebhookTriggers(wf.steps, hits);
    if (hits.some((h) => !h.secret)) openTriggers.push(label);
  }
  return { openTriggers, outgoing };
}

/** Read-only scan of the SQLite workflow table. Never creates the file. */
export function scanSqliteWorkflows(file: string): WebhookScan {
  const empty = { openTriggers: [], outgoing: [] };
  if (!file || !fs.existsSync(file)) return { scanned: false, reason: 'no database file yet', ...empty };
  let db: { prepare(sql: string): { all(): unknown[] }; close(): void } | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3');
    db = new Database(file, { readonly: true, fileMustExist: true });
    const rows = db!.prepare('SELECT data FROM workflows').all() as { data: string }[];
    const recs = rows.map((r) => { try { return JSON.parse(r.data); } catch { return null; } });
    return { scanned: true, ...scanWorkflowRecords(recs) };
  } catch (e) {
    return { scanned: false, reason: e instanceof Error ? e.message : String(e), ...empty };
  } finally {
    try { db?.close(); } catch { /* */ }
  }
}

// ── The checks ──────────────────────────────────────────────────────────────

export interface SecurityInputs {
  profile: string;                 // development | server | production | test
  debugBind: string;
  chromeEnabled: boolean;
  redisUrl: string;
  publicDomain: string;
  webhookSecret: string;
  storageDriver: 'sqlite' | 'redis';
  sqlitePath: string;
  liveShareTtlSec: number;
  /** Where to look for docker-compose*.yml. */
  composeDir?: string;
  /** Network probe; omit to skip probing (tests, `test` profile). */
  probe?: TcpProbe;
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>;
  /** Pre-scanned workflows (tests); omit to scan the SQLite file. */
  webhookScan?: WebhookScan;
}

const reachableProfile = (p: string) => p === 'server' || p === 'production';

export async function runSecurityChecks(i: SecurityInputs): Promise<SecurityReport> {
  const issues: ValidationIssue[] = [];
  const checks: CheckLine[] = [];
  const add = (c: CheckLine, issue?: ValidationIssue) => { checks.push(c); if (issue) issues.push(issue); };

  // 1. DevTools bind ────────────────────────────────────────────────────────
  if (!i.chromeEnabled) {
    add({ id: 'debug_bind', label: 'Chrome DevTools bind address', state: 'skipped', detail: 'Remote Browser is disabled' });
  } else if (isLoopbackBind(i.debugBind)) {
    add({ id: 'debug_bind', label: 'Chrome DevTools bind address', state: 'ok', detail: `${i.debugBind || '127.0.0.1'} (this machine only)` });
  } else {
    const wild = isWildcardBind(i.debugBind);
    add(
      { id: 'debug_bind', label: 'Chrome DevTools bind address', state: 'warn', detail: i.debugBind },
      {
        id: 'debug_bind_exposed',
        severity: 'warn',
        feature: 'Remote Browser security',
        problem: `REAL_CHROME_DEBUG_BIND=${i.debugBind}${wild ? ' listens on EVERY network interface' : ''}. `
          + 'Chrome\'s DevTools port gives remote code execution and every cookie in the profile '
          + 'to anyone who can reach it — it has no authentication of its own.',
        fix: 'Remove REAL_CHROME_DEBUG_BIND (default 127.0.0.1) or set it to 127.0.0.1. If you really need '
          + 'remote access, put it behind a VPN/SSH tunnel or an authenticating reverse proxy, never on a public interface.',
      },
    );
  }

  // 2. Redis exposure ───────────────────────────────────────────────────────
  {
    const exposures: string[] = [];
    let probed = false;
    const composeDir = i.composeDir;
    if (composeDir) {
      const { exposed } = scanComposeDir(composeDir);
      for (const e of exposed) exposures.push(`${e.file} publishes "${e.mapping}" to all interfaces`);
    }
    const target = parseRedisUrl(i.redisUrl);
    if (target && i.probe) {
      const local = localExternalAddresses(i.interfaces);
      const isHere = isLoopbackHost(target.host) || local.includes(target.host) || target.host === '0.0.0.0';
      if (isHere) {
        probed = true;
        const results = await Promise.all(local.map(async (addr) => ({ addr, r: await i.probe!(addr, target.port) })));
        for (const { addr, r } of results) {
          if (r.reachable) {
            exposures.push(`port ${target.port} accepts connections on ${addr}`
              + (r.answer === 'pong' ? ' and answers PING without a password' : r.answer === 'noauth' ? ' (password required)' : ''));
          }
        }
      }
    }
    if (exposures.length) {
      add(
        { id: 'redis_exposed', label: 'Redis port not exposed', state: 'warn', detail: exposures.join('; ') },
        {
          id: 'redis_port_exposed',
          severity: 'warn',
          feature: 'Redis security',
          problem: 'Redis is reachable beyond this machine: ' + exposures.join('; ') + '. '
            + 'Redis is the job queue — whoever can write to it can make this server run arbitrary workflows.',
          fix: 'Bind Redis to 127.0.0.1 (redis.conf: `bind 127.0.0.1`, `protected-mode yes`) or, in Docker, delete the '
            + '`ports:` entry of the redis service (the app reaches it over the compose network) or publish it as '
            + '"127.0.0.1:6379:6379". Add `requirepass` and put the password in REDIS_URL if it must be reachable.',
        },
      );
    } else {
      add({
        id: 'redis_exposed', label: 'Redis port not exposed',
        state: i.composeDir || probed ? 'ok' : 'skipped',
        detail: probed ? 'not reachable on this host\'s external addresses'
          : i.composeDir ? 'no compose file publishes 6379' : 'not checked',
      });
    }
  }

  // 3. Public domain / HTTPS (static part) ──────────────────────────────────
  if (!i.publicDomain.trim()) {
    add({ id: 'https', label: 'HTTPS for the public domain', state: 'skipped', detail: 'PUBLIC_DOMAIN is not set' });
  } else {
    const origin = normalizeConfiguredDomain(i.publicDomain);
    const host = origin ? new URL(origin).host : '';
    if (!origin) {
      add({ id: 'https', label: 'HTTPS for the public domain', state: 'warn', detail: `unparseable: ${i.publicDomain}` },
        {
          id: 'public_domain_invalid', severity: 'warn', feature: 'HTTPS',
          problem: `PUBLIC_DOMAIN="${i.publicDomain}" is not a valid http(s) address.`,
          fix: 'Use a full address such as https://plyr.example.com',
        });
    } else if (new URL(origin).protocol === 'http:' && !isLoopbackHost(host)) {
      add({ id: 'https', label: 'HTTPS for the public domain', state: 'warn', detail: origin },
        {
          id: 'public_domain_not_https', severity: 'warn', feature: 'HTTPS',
          problem: `PUBLIC_DOMAIN is ${origin} — plain http on a non-local host. The API token, the pairing code `
            + 'and the session cookie cross the network in clear text.',
          fix: 'Terminate TLS in front of the app (Caddy does it automatically: see Caddyfile.example / install.sh) '
            + 'and set PUBLIC_DOMAIN=https://<your-domain>.',
        });
    } else {
      add({ id: 'https', label: 'HTTPS for the public domain', state: 'ok', detail: origin });
    }
  }

  // 4. Webhooks without HMAC ────────────────────────────────────────────────
  {
    const domainPublic = (() => {
      const o = normalizeConfiguredDomain(i.publicDomain);
      return !!o && !isLoopbackHost(new URL(o).host);
    })();
    const exposedInstance = reachableProfile(i.profile) || domainPublic;
    if (!exposedInstance) {
      add({ id: 'webhook_hmac', label: 'Webhooks are signed / authenticated', state: 'skipped', detail: 'instance is local-only' });
    } else {
      const scan = i.webhookScan
        ?? (i.storageDriver === 'sqlite' ? scanSqliteWorkflows(i.sqlitePath)
          : { scanned: false, reason: 'STORAGE_DRIVER=redis (workflows are not scanned)', openTriggers: [], outgoing: [] });
      const parts: string[] = [];
      if (scan.openTriggers.length) {
        parts.push(`active workflow(s) with a Webhook trigger and no secret: ${scan.openTriggers.slice(0, 5).join(', ')}`
          + (scan.openTriggers.length > 5 ? ` (+${scan.openTriggers.length - 5} more)` : ''));
      }
      if (!i.webhookSecret && scan.outgoing.length) {
        parts.push(`${scan.outgoing.length} workflow(s) send results to a webhookUrl but WEBHOOK_SECRET is empty, so the receiver cannot verify them`);
      }
      if (parts.length) {
        add({ id: 'webhook_hmac', label: 'Webhooks are signed / authenticated', state: 'warn', detail: parts.join('; ') },
          {
            id: 'webhook_without_hmac', severity: 'warn', feature: 'Webhooks',
            problem: 'On a reachable instance: ' + parts.join('; ') + '.',
            fix: 'Fill the "secret" field of every Webhook trigger (HMAC-SHA256 over the exact body, X-Signature) '
              + 'and set WEBHOOK_SECRET in .env so outgoing webhooks are signed too.',
          });
      } else {
        add({
          id: 'webhook_hmac', label: 'Webhooks are signed / authenticated',
          state: scan.scanned ? 'ok' : 'skipped',
          detail: scan.scanned ? 'no unauthenticated webhook trigger found' : (scan.reason || 'not scanned'),
        });
      }
    }
  }

  // 5. Share-link lifetime ──────────────────────────────────────────────────
  {
    const ttl = i.liveShareTtlSec;
    if (ttl === 0) {
      add({ id: 'live_share_ttl', label: 'Live share-link lifetime', state: 'warn', detail: 'never expires' },
        {
          id: 'live_share_ttl', severity: 'warn', feature: 'Live share links',
          problem: 'LIVE_SHARE_TTL_SEC=0: every share link stays valid forever, and a link shows a live view of the browser to whoever holds it.',
          fix: `Set LIVE_SHARE_TTL_SEC to a finite value (default ${DEFAULT_LIVE_SHARE_TTL_SEC}).`,
        });
    } else if (ttl > LONG_LIVE_SHARE_TTL_SEC) {
      add({ id: 'live_share_ttl', label: 'Live share-link lifetime', state: 'warn', detail: `${ttl}s` },
        {
          id: 'live_share_ttl', severity: 'warn', feature: 'Live share links',
          problem: `LIVE_SHARE_TTL_SEC=${ttl} (> 24 h): a leaked link keeps showing the browser for days.`,
          fix: `Use a shorter value (default ${DEFAULT_LIVE_SHARE_TTL_SEC}); a link is minted fresh for every run.`,
        });
    } else {
      add({ id: 'live_share_ttl', label: 'Live share-link lifetime', state: 'ok', detail: `${ttl}s` });
    }
  }

  return { issues, checks };
}

// ── Doctor-only: does TLS actually answer on the domain? ────────────────────

export interface TlsProbeResult { ok: boolean; detail: string }
export type TlsProbe = (host: string, port: number) => Promise<TlsProbeResult>;

/** Real handshake, 4 s budget. Reads the certificate; sends no HTTP. */
export const probeTls: TlsProbe = (host, port) => new Promise((resolve) => {
  let done = false;
  const finish = (r: TlsProbeResult) => { if (!done) { done = true; try { sock.destroy(); } catch { /* */ } resolve(r); } };
  const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 4000 }, () => {
    const cert = sock.getPeerCertificate();
    const left = cert && cert.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : NaN;
    if (!sock.authorized) finish({ ok: false, detail: `certificate rejected: ${String(sock.authorizationError)}` });
    else if (Number.isFinite(left) && left < 14) finish({ ok: false, detail: `certificate expires in ${left} day(s)` });
    else finish({ ok: true, detail: Number.isFinite(left) ? `valid certificate, ${left} day(s) left` : 'valid certificate' });
  });
  sock.once('timeout', () => finish({ ok: false, detail: `no TLS answer from ${host}:${port} within 4 s` }));
  sock.once('error', (e) => finish({ ok: false, detail: `${host}:${port} — ${e.message}` }));
});

/**
 * Doctor-only (an outbound handshake does not belong in server boot): when a
 * public https domain is configured, check that TLS really answers there.
 */
export async function runHttpsProbe(publicDomain: string, probe: TlsProbe = probeTls): Promise<SecurityReport> {
  const origin = normalizeConfiguredDomain(publicDomain);
  const checks: CheckLine[] = [];
  const issues: ValidationIssue[] = [];
  if (!origin) return { issues, checks };
  const u = new URL(origin);
  if (u.protocol !== 'https:' || isLoopbackHost(u.host)) return { issues, checks };
  const r = await probe(u.hostname, u.port ? parseInt(u.port, 10) : 443);
  if (r.ok) {
    checks.push({ id: 'https_probe', label: `TLS on ${u.host}`, state: 'ok', detail: r.detail });
  } else {
    checks.push({ id: 'https_probe', label: `TLS on ${u.host}`, state: 'warn', detail: r.detail });
    issues.push({
      id: 'https_unreachable', severity: 'warn', feature: 'HTTPS',
      problem: `PUBLIC_DOMAIN is ${origin} but TLS does not check out from here: ${r.detail}.`,
      fix: 'Run the reverse proxy that terminates TLS (Caddy: install.sh writes the Caddyfile from Caddyfile.example and '
        + 'obtains the certificate automatically). Check that the DNS record points at this server and ports 80/443 are open. '
        + 'If this machine simply cannot reach its own public address, ignore this line.',
    });
  }
  return { issues, checks };
}
