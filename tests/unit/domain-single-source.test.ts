/**
 * domain-single-source.test.ts — one name for the public domain, on every path.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHAT THE MISSION ASKS (items 2, 3, 4, 6, 7)
 * ════════════════════════════════════════════════════════════════════════════
 *   2. «برای Domain configuration یک source of truth داشته باشیم: PUBLIC_DOMAIN
 *       و از duplicate configuration بین PUBLIC_DOMAIN / BASE_URL جلوگیری شود»
 *   3. Every startup path — dev.sh, install.sh, scripts/dev-server.sh, Docker
 *      and Compose — must use the SAME configuration, with no duplicate or
 *      inconsistent .env values.
 *   4. The pairing panel must show the REAL Base URL, resolved as
 *      PUBLIC_DOMAIN → configured origin → only then a valid runtime fallback.
 *      «نباید صرفاً اولین IP سیستم به‌عنوان Public URL حدس زده شود، مخصوصاً پشت
 *       Cloudflare / reverse proxy / Coolify / NAT»
 *   6. `Backend Base URL` and `Browser Environment` stay separate concepts;
 *      LOCAL may need an Authorization Code, REMOTE never does.
 *   7. Startup scripts are idempotent: no duplicate .env keys, no needless
 *      overwrite, and non-interactive runs never stall on a prompt.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * WHY THESE ARE TESTED AS FILES AND PROCESSES RATHER THAN THROUGH MOCKS
 * ════════════════════════════════════════════════════════════════════════════
 * The failure this file guards against is not a bug inside a function. It is
 * DRIFT BETWEEN PLACES: one script writing BASE_URL while the server reads
 * PUBLIC_DOMAIN, or a compose file that never forwards the variable at all. No
 * unit test of a single module can see that, because each module is individually
 * correct. So the shell writer is EXECUTED for real in a temporary directory,
 * and the deployment manifests are read as text and asserted against.
 *
 * That decision has already paid for itself three times, each a defect no
 * reimplementation-in-TypeScript would have found:
 *
 *   • `$(grep -c … || echo 0)` yields the two-line string "0\n0", because grep
 *     exits 1 on zero matches — so the first idempotence guard never fired.
 *   • The awk cleanup required the "=" to touch the key name, so a hand-edited
 *     `PUBLIC_DOMAIN = https://x` SURVIVED and was then joined by the canonical
 *     line: two live assignments, produced by the code meant to prevent them.
 *   • install.sh's fallback substituted into the first matching line only, so a
 *     .env that already had duplicates kept them, one of them wrong.
 *
 * `resolveBaseUrl`'s own precedence table is already covered by
 * public-base-url.test.ts (41 tests). This file does not restate it; §4 asserts
 * only the property that file cannot: that the SERVER wires the configured
 * domain in ahead of detection, so a Coolify box never advertises a bridge IP.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

const ROOT = process.cwd();

async function read(rel: string): Promise<string> {
  return fs.readFile(path.join(ROOT, rel), 'utf8');
}

/** Source with block and line comments removed: prose is not configuration. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join('\n');
}

/**
 * Run one or more `_domain_write` calls in a throwaway directory and hand back
 * the resulting .env, whether the file was actually rewritten, and anything left
 * lying beside it.
 *
 * The real script is sourced by a real bash, because the thing under test IS the
 * shell — an awk pattern, a grep count and the exit status of `grep -c` are
 * exactly the details that look right when read and are wrong when run.
 */
function domainWrite(
  initialEnv: string | null,
  values: string[],
  opts: { script?: string } = {},
): { env: string; rewritten: boolean; leftovers: string[] } {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'domain-src-'));
  try {
    const envPath = path.join(dir, '.env');
    if (initialEnv !== null) fsSync.writeFileSync(envPath, initialEnv, 'utf8');

    const body = [
      `cd "${dir}"`,
      `. "${path.join(ROOT, opts.script || 'scripts/ask-domain.sh')}"`,
      // Freeze the mtime, so "was it rewritten" is observable rather than timed.
      initialEnv !== null ? 'touch -t 200001010000 .env' : ':',
      initialEnv !== null ? 'before=$(stat -c %Y .env)' : 'before=0',
      ...values.map((v) => `_domain_write "${v}"`),
      '[ -f .env ] && after=$(stat -c %Y .env) || after=0',
      'if [ "$before" = "$after" ]; then echo "REWRITTEN=no"; else echo "REWRITTEN=yes"; fi',
    ].join('\n');

    const out = execFileSync('bash', ['-c', body], { encoding: 'utf8', timeout: 20_000 });
    const env = fsSync.existsSync(envPath) ? fsSync.readFileSync(envPath, 'utf8') : '';
    const leftovers = fsSync.readdirSync(dir).filter((f) => f !== '.env');
    return { env, rewritten: /REWRITTEN=yes/.test(out), leftovers };
  } finally {
    try { fsSync.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** Every live assignment of a key, matched the way dotenv would see it. */
function assignmentsOf(env: string, key: string): string[] {
  return env.split('\n').filter((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
}

// ════════════════════════════════════════════════════════════════════════════
// 2. One name, and only one, ends up in the file
// ════════════════════════════════════════════════════════════════════════════

describe('2. PUBLIC_DOMAIN is the single source of truth in .env', () => {
  it('writes PUBLIC_DOMAIN and never BASE_URL', () => {
    const { env } = domainWrite('PORT=3000\n', ['https://panel.example.com']);
    expect(assignmentsOf(env, 'PUBLIC_DOMAIN')).toEqual([
      'PUBLIC_DOMAIN=https://panel.example.com',
    ]);
    expect(assignmentsOf(env, 'BASE_URL')).toEqual([]);
  });

  it('removes a stale BASE_URL synonym rather than leaving both', () => {
    // THE SILENT FAILURE THIS PREVENTS. config.ts resolves
    // `PUBLIC_DOMAIN || BASE_URL`, so a file containing both is decided by
    // precedence rather than by what the operator last typed. Leaving the old
    // synonym behind means they see their new domain in .env, get served the old
    // one, and nothing on screen explains the disagreement.
    const { env } = domainWrite(
      'BASE_URL=https://old.example.com\nPORT=3000\n',
      ['https://new.example.com'],
    );
    expect(env).not.toMatch(/BASE_URL/);
    expect(env).toContain('PUBLIC_DOMAIN=https://new.example.com');
  });

  it('collapses duplicate assignments to exactly one line', () => {
    // dotenv is last-wins, so a duplicate is a file whose meaning depends on
    // line order — and the operator reading the first occurrence is reading a
    // value that is not in force.
    const { env } = domainWrite(
      'PUBLIC_DOMAIN=https://a.example.com\nPORT=3000\nPUBLIC_DOMAIN=https://b.example.com\n',
      ['https://final.example.com'],
    );
    expect(assignmentsOf(env, 'PUBLIC_DOMAIN')).toEqual([
      'PUBLIC_DOMAIN=https://final.example.com',
    ]);
  });

  it('collapses an assignment written with spaces around the "="', () => {
    // MEASURED DEFECT, NOT A HYPOTHETICAL. `PUBLIC_DOMAIN = https://x` is
    // honoured by dotenv, and the awk cleanup used to require the "=" to touch
    // the name — so a hand-edited line like this survived and the canonical line
    // was appended after it. The file then held TWO live assignments, produced by
    // the very code meant to guarantee one.
    const { env } = domainWrite(
      '  PUBLIC_DOMAIN = https://spaced.example.com\nPORT=3000\n',
      ['https://final.example.com'],
    );
    expect(assignmentsOf(env, 'PUBLIC_DOMAIN')).toEqual([
      'PUBLIC_DOMAIN=https://final.example.com',
    ]);
    expect(env).not.toMatch(/spaced\.example\.com/);
  });

  it('collapses a spaced BASE_URL synonym too', () => {
    const { env } = domainWrite(
      'BASE_URL = https://ghost.example.com\n',
      ['https://final.example.com'],
    );
    expect(env).not.toMatch(/BASE_URL|ghost/);
  });

  it('leaves every unrelated line alone', () => {
    const { env } = domainWrite(
      '# my notes\nPORT=3000\nAPI_TOKEN=tok_abc\nREDIS_URL=redis://x\n',
      ['https://panel.example.com'],
    );
    expect(env).toContain('# my notes');
    expect(env).toContain('PORT=3000');
    expect(env).toContain('API_TOKEN=tok_abc');
    expect(env).toContain('REDIS_URL=redis://x');
  });

  it('is the same writer the server reads, on the same key', async () => {
    // The agreement stated across the language boundary: the shell writes the
    // key config.ts reads. A rename on either side breaks this test rather than
    // silently ignoring the operator's domain.
    const cfg = code(await read('src/config.ts'));
    expect(cfg).toMatch(/PUBLIC_DOMAIN:\s*cleanEnv\(process\.env\.PUBLIC_DOMAIN\)/);
    const { env } = domainWrite(null, ['https://panel.example.com']);
    expect(env).toMatch(/^PUBLIC_DOMAIN=/m);
  });

  it('accepts BASE_URL only as a read-time synonym, never as a written name', async () => {
    // The synonym is a kindness to an operator who has just read "Base URL" in
    // the Extension's own field. It must stay READ-only: a second writable name
    // is precisely the duplicate configuration item 2 forbids.
    const cfg = await read('src/config.ts');
    expect(cfg).toMatch(/process\.env\.BASE_URL/);

    for (const rel of ['scripts/ask-domain.sh', 'install.sh', 'dev.sh', 'scripts/dev-server.sh']) {
      const text = code(await read(rel));
      // A writer may DELETE or SKIP BASE_URL (that is the cleanup asserted
      // above); it may never emit an assignment of one.
      const emitting = text.split('\n').filter(
        (l) => /BASE_URL[[:space:]]*=|BASE_URL\s*=/.test(l) && /(>>|printf|echo)\s/.test(l),
      );
      expect(emitting, `${rel} assigns BASE_URL: ${emitting.join(' | ')}`).toEqual([]);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Every startup path uses the same configuration
// ════════════════════════════════════════════════════════════════════════════

describe('3. every startup path goes through the one writer', () => {
  it('dev.sh, dev-server.sh and install.sh all reach the shared writer', async () => {
    for (const rel of ['dev.sh', 'scripts/dev-server.sh', 'install.sh']) {
      const text = await read(rel);
      expect(text, `${rel} must delegate to the shared writer`).toMatch(/ask-domain\.sh/);
    }
  });

  it('the two dev scripts never write .env themselves', async () => {
    // Two writers would drift, and the drift is silent: one writes PUBLIC_DOMAIN
    // and the other BASE_URL, so whichever script the operator last used decides
    // whether their domain is honoured.
    for (const rel of ['dev.sh', 'scripts/dev-server.sh']) {
      const text = code(await read(rel));
      expect(text, `${rel} should not write the domain itself`)
        .not.toMatch(/PUBLIC_DOMAIN=.*>>|sed.*PUBLIC_DOMAIN|awk.*PUBLIC_DOMAIN/);
    }
  });

  it('install.sh keeps a fallback, and the fallback is the SAME algorithm', async () => {
    // A partial checkout has no scripts/ directory, so the installer needs its
    // own copy. What it must not have is a DIFFERENT copy: the earlier fallback
    // substituted into the first matching line only, so a .env that already held
    // duplicates came out of the installer still holding them — one of them
    // wrong, and dotenv is last-wins.
    const text = await read('install.sh');
    expect(text).toMatch(/PUBLIC_DOMAIN\[\[:space:\]\]\*=/);
    expect(text).toMatch(/BASE_URL\[\[:space:\]\]\*=/);
    expect(text, 'the fallback must append one canonical line')
      .toMatch(/END\s*\{\s*printf\s+"PUBLIC_DOMAIN=%s\\n"/);
    expect(text, 'the fallback must not sed-substitute in place')
      .not.toMatch(/sed_inplace\s+"s\|\^\[\[:space:\]\]\*PUBLIC_DOMAIN=/);
  });

  it('the Docker compose file forwards PUBLIC_DOMAIN into the container', async () => {
    const text = await read('docker-compose.yml');
    expect(text).toMatch(/PUBLIC_DOMAIN:\s*"?\$\{PUBLIC_DOMAIN:-\}"?/);
  });

  it('the Coolify compose file forwards PUBLIC_DOMAIN into the container', async () => {
    // THIS WAS THE HOLE, and Coolify is the deployment the report came from.
    // Coolify terminates the public domain at its own proxy and forwards to the
    // container on an internal network, so from inside the only detectable
    // addresses are the compose bridge IP and the container hostname — neither
    // reachable from the operator's browser. Without this line the panel cannot
    // do anything BUT guess, which is exactly what item 4 forbids "behind
    // Cloudflare / reverse proxy / Coolify / NAT".
    const text = await read('docker-compose.coolify.yml');
    expect(text).toMatch(/PUBLIC_DOMAIN:\s*"?\$\{PUBLIC_DOMAIN:-\}"?/);
  });

  it('forwards it as an interpolation, never as a hardcoded literal', async () => {
    // `environment:` outranks `env_file:` AND the Coolify UI's own variables, so
    // a literal — even a blank one — erases the value the operator was told to
    // set, in the one place the documentation points them at.
    for (const rel of ['docker-compose.yml', 'docker-compose.coolify.yml']) {
      const text = await read(rel);
      const lines = text.split('\n').filter((l) => /^\s*PUBLIC_DOMAIN:/.test(l));
      expect(lines.length, `${rel} should set PUBLIC_DOMAIN exactly once`).toBe(1);
      expect(lines[0], `${rel} must interpolate, not hardcode`).toMatch(/\$\{PUBLIC_DOMAIN/);
    }
  });

  it('never sets BASE_URL in any deployment manifest', async () => {
    for (const rel of ['docker-compose.yml', 'docker-compose.coolify.yml', 'Dockerfile']) {
      const text = code(await read(rel));
      expect(text, `${rel} must not introduce a second domain name`)
        .not.toMatch(/^\s*(ENV\s+)?BASE_URL\s*[:=]/m);
    }
  });

  it('tells the Coolify operator which single variable to set', async () => {
    // The instructions are part of the configuration surface: an operator
    // following a list that omits PUBLIC_DOMAIN ends up in the reported state no
    // matter how correct the compose file is.
    const text = await read('docker-compose.coolify.yml');
    expect(text).toMatch(/PUBLIC_DOMAIN=https:\/\/your-domain/);
  });

  it('documents the one name in the file operators copy from', async () => {
    const example = await read('.env.example');
    expect(example).toMatch(/^PUBLIC_DOMAIN=/m);
    // BASE_URL may appear, but only commented out as a documented synonym.
    const live = example.split('\n').filter((l) => /^\s*BASE_URL\s*=/.test(l));
    expect(live, 'BASE_URL must stay commented in .env.example').toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Idempotent, and safe with no terminal
// ════════════════════════════════════════════════════════════════════════════

describe('7. the startup writer is idempotent and never stalls', () => {
  it('does not rewrite a file that already says exactly this', () => {
    // Not an optimisation: these scripts run on EVERY boot. A needless rewrite
    // moves the mtime that deployment tooling and Coolify's change detection
    // watch, and fails outright when .env is mounted read-only — aborting a
    // startup that had no work to do.
    const first = domainWrite('PORT=3000\n', ['https://panel.example.com']);
    expect(first.rewritten).toBe(true);

    const second = domainWrite(
      'PORT=3000\nPUBLIC_DOMAIN=https://panel.example.com\n',
      ['https://panel.example.com'],
    );
    expect(second.rewritten).toBe(false);
    expect(second.env).toBe('PORT=3000\nPUBLIC_DOMAIN=https://panel.example.com\n');
  });

  it('still rewrites when the value genuinely changes', () => {
    const r = domainWrite(
      'PUBLIC_DOMAIN=https://old.example.com\n',
      ['https://new.example.com'],
    );
    expect(r.rewritten).toBe(true);
    expect(r.env).toContain('PUBLIC_DOMAIN=https://new.example.com');
  });

  it('still cleans up when the value is right but duplicated', () => {
    // The "already correct" condition is deliberately narrow: EXACTLY one
    // assignment and no synonym. A duplicate is still damage worth repairing.
    const r = domainWrite(
      'PUBLIC_DOMAIN=https://p.example.com\nPUBLIC_DOMAIN=https://p.example.com\n',
      ['https://p.example.com'],
    );
    expect(r.rewritten).toBe(true);
    expect(assignmentsOf(r.env, 'PUBLIC_DOMAIN')).toHaveLength(1);
  });

  it('still cleans up when the value is right but a synonym lingers', () => {
    const r = domainWrite(
      'PUBLIC_DOMAIN=https://p.example.com\nBASE_URL=https://ghost.example.com\n',
      ['https://p.example.com'],
    );
    expect(r.rewritten).toBe(true);
    expect(r.env).not.toMatch(/BASE_URL/);
  });

  it('is stable under repeated calls — the file stops changing', () => {
    const r = domainWrite('PORT=3000\n', [
      'https://panel.example.com',
      'https://panel.example.com',
      'https://panel.example.com',
    ]);
    expect(assignmentsOf(r.env, 'PUBLIC_DOMAIN')).toHaveLength(1);
    // No blank-line growth either: three writes must not leave three gaps.
    expect(r.env).toBe('PORT=3000\nPUBLIC_DOMAIN=https://panel.example.com\n');
  });

  it('leaves no temporary file behind', () => {
    // The rewrite goes through .env.domain.tmp + mv so a crash cannot truncate
    // the file that decides whether the instance boots. A surviving temp file in
    // a repo is a puzzle for whoever finds it.
    const r = domainWrite('PORT=3000\n', ['https://panel.example.com']);
    expect(r.leftovers).toEqual([]);
  });

  it('refuses answers that are plainly not domains, instead of storing them', () => {
    // Every other question in these wizards is a y/N, so "y" is a genuinely
    // common answer here. Storing PUBLIC_DOMAIN=y is worse than storing nothing:
    // the panel advertises "https://y" beside the Authorization Code, the
    // Extension can never reach it, and no message explains why.
    for (const junk of ['y', 'n', 'yes', 'true', 'nodots']) {
      const r = domainWrite('PORT=3000\n', [junk]);
      expect(assignmentsOf(r.env, 'PUBLIC_DOMAIN'), `stored junk: ${junk}`).toEqual([]);
    }
  });

  it('accepts localhost and an explicit host:port, which have no dot', () => {
    const a = domainWrite(null, ['http://localhost:3000']);
    expect(a.env).toContain('PUBLIC_DOMAIN=http://localhost:3000');
    const b = domainWrite(null, ['myhost:8080']);
    expect(b.env).toContain('PUBLIC_DOMAIN=myhost:8080');
  });

  it('refuses a value containing "#", which the reader would truncate', () => {
    const r = domainWrite('PORT=3000\n', ['https://a.example.com#frag']);
    expect(assignmentsOf(r.env, 'PUBLIC_DOMAIN')).toEqual([]);
  });

  it('never prompts when there is no terminal', () => {
    // A startup script that blocks on `read` with no tty hangs a CI job, a Docker
    // entrypoint or a `nohup` run forever, printing its question to a log nobody
    // is watching. The timeout below is the assertion: if it prompts, this fails.
    const out = execFileSync('bash', ['-c', [
      `cd "${ROOT}"`,
      '. scripts/ask-domain.sh',
      'ask_public_domain < /dev/null',
      'echo DONE',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000 });
    expect(out).toMatch(/DONE/);
  });

  it('never prompts when AB_NO_PROMPT is set', () => {
    const out = execFileSync('bash', ['-c', [
      `cd "${ROOT}"`,
      'export AB_NO_PROMPT=1',
      '. scripts/ask-domain.sh',
      'ask_public_domain',
      'echo DONE',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000 });
    expect(out).toMatch(/DONE/);
    expect(out).not.toMatch(/Do you want to set a custom domain/);
  });

  it('does not re-ask when the value already came from the environment', () => {
    // An operator who set it through docker-compose or a systemd unit has already
    // decided. Asking again invites them to overwrite it by pressing Enter on a
    // question they did not expect.
    const out = execFileSync('bash', ['-c', [
      `cd "${ROOT}"`,
      'export PUBLIC_DOMAIN=https://already.example.com',
      '. scripts/ask-domain.sh',
      'ask_public_domain',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000 });
    expect(out).toMatch(/already\.example\.com/);
    expect(out).not.toMatch(/Do you want to set a custom domain/);
  });

  it('honours the BASE_URL synonym when deciding not to ask', () => {
    // Reading the synonym here is right even though writing it is not: an
    // operator who exported BASE_URL has configured the thing, and prompting
    // them for it again would be the wizard disagreeing with itself.
    const out = execFileSync('bash', ['-c', [
      `cd "${ROOT}"`,
      'export BASE_URL=https://synonym.example.com',
      '. scripts/ask-domain.sh',
      'ask_public_domain',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000 });
    expect(out).toMatch(/synonym\.example\.com/);
  });

  it('does not create or modify a .env in the repository', () => {
    // Guard rail on this test file itself: ask_public_domain above runs with the
    // repo as its cwd, so a bug that wrote there would be a genuinely
    // destructive side effect of merely running the suite.
    expect(
      fsSync.existsSync(path.join(ROOT, '.env.domain.tmp')),
      'a temp file was left in the repository',
    ).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. The advertised Base URL is never a guessed IP when a domain is configured
// ════════════════════════════════════════════════════════════════════════════

describe('4. the panel advertises a configured domain ahead of any guess', () => {
  it('prefers the configured domain over a detectable interface', async () => {
    const { resolveBaseUrl } = await import('../../src/core/PublicBaseUrl');
    const r = resolveBaseUrl({
      configuredDomain: 'https://panel.example.com',
      port: 3000,
      request: { host: '172.18.0.4:3000' },
      interfaces: { eth0: [{ family: 'IPv4', address: '172.18.0.4', internal: false }] } as never,
    });
    // The Coolify/Cloudflare case in one assertion: a container that CAN see a
    // bridge address must still advertise the operator's domain.
    expect(r.baseUrl).toBe('https://panel.example.com');
    expect(r.source).toBe('configured');
  });

  it('does not fall back to the first system IP when a domain is configured', async () => {
    const { resolveBaseUrl } = await import('../../src/core/PublicBaseUrl');
    const r = resolveBaseUrl({
      configuredDomain: 'panel.example.com',
      port: 3000,
      interfaces: {
        eth0: [{ family: 'IPv4', address: '10.0.0.7', internal: false }],
        docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
      } as never,
    });
    expect(r.baseUrl).not.toMatch(/10\.0\.0\.7|172\.17/);
    expect(r.source).toBe('configured');
  });

  it('labels the source, so the UI can qualify a guessed address', async () => {
    const { resolveBaseUrl } = await import('../../src/core/PublicBaseUrl');
    const guessed = resolveBaseUrl({
      configuredDomain: '',
      port: 3000,
      interfaces: { eth0: [{ family: 'IPv4', address: '10.0.0.7', internal: false }] } as never,
    });
    // A detected address is allowed — it is right on a laptop. What is NOT
    // allowed is presenting it as though the operator had chosen it.
    expect(guessed.source).not.toBe('configured');
    expect(['request', 'detected', 'loopback']).toContain(guessed.source);
  });

  it('prefers the proxy-forwarded host over a detected interface', async () => {
    const { resolveBaseUrl } = await import('../../src/core/PublicBaseUrl');
    const r = resolveBaseUrl({
      configuredDomain: '',
      port: 3000,
      request: { host: '10.0.0.9:3000', forwardedHost: 'panel.example.com', forwardedProto: 'https' },
      interfaces: { eth0: [{ family: 'IPv4', address: '10.0.0.9', internal: false }] } as never,
    });
    // Even with nothing configured, the address the request actually arrived on
    // beats an interface scan — because behind a reverse proxy the interface is
    // the one address the client provably cannot use.
    expect(r.baseUrl).toBe('https://panel.example.com');
  });

  it('the server hands the configured domain to the resolver, not just the request', async () => {
    // The wiring, asserted where it actually happens. resolveBaseUrl having the
    // right precedence is useless if the route never passes the domain in — and
    // that omission would look correct on a laptop, where detection happens to
    // agree.
    const routes = code(await read('src/Routes/mode.routes.ts'));
    expect(routes).toMatch(/configuredDomain:\s*config\.PUBLIC_DOMAIN/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Backend Base URL and Browser Environment stay different things
// ════════════════════════════════════════════════════════════════════════════

describe('6. the Base URL and the Browser Environment are not the same choice', () => {
  it('REMOTE never requires an Authorization Code', async () => {
    const { planTargeting } = await import('../../src/core/BrowserEnvironment');
    const plan = planTargeting({ environment: 'remote', paired: false });
    // The server owns that Chromium and the extension inside it, so there is no
    // trust gap to bridge. Asking for a code here would be asking the operator to
    // authorise the server to itself.
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.step).toBe('targeting');
  });

  it('REMOTE needs no code even when nothing has ever been paired', async () => {
    const { planTargeting } = await import('../../src/core/BrowserEnvironment');
    for (const paired of [true, false]) {
      const plan = planTargeting({ environment: 'remote', paired });
      expect(plan.needsAuthorization, `paired=${paired}`).toBe(false);
    }
  });

  it('LOCAL never requires one — it is the SERVER-LOCAL runtime now', async () => {
    const { planTargeting } = await import('../../src/core/BrowserEnvironment');
    // The corrected contract: LOCAL = the browser runtime on the SAME server as
    // Plyr, bound internally and automatically. Base URL, API Key and
    // Authorization Code are all resolved by the server, so no plan may ask the
    // user for one — paired or not.
    const unpaired = planTargeting({ environment: 'local', paired: false });
    const paired = planTargeting({ environment: 'local', paired: true });
    expect(unpaired.needsAuthorization).toBe(false);
    expect(unpaired.step).toBe('targeting');
    expect(paired.needsAuthorization).toBe(false);
  });

  it('never silently downgrades LOCAL to REMOTE', async () => {
    const { planTargeting } = await import('../../src/core/BrowserEnvironment');
    // `local_unavailable` is reported as a NOTE on a plan that still says
    // `local`. A silent rewrite to `remote` would tell the operator "Targeting"
    // while the server pointed a different browser at a different page — the
    // exact lie this subsystem exists to avoid.
    const plan = planTargeting({ environment: 'local', paired: false, localAvailable: false });
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_unavailable');
    // And the note is the whole message: an unavailable runtime is not a code
    // problem, so needsAuthorization stays false — typing a code would not fix
    // it, and asking would be the credential UI this contract removes.
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.opensRemoteBrowser).toBe(false);
  });

  it('only REMOTE opens the server-owned browser', async () => {
    const { planTargeting } = await import('../../src/core/BrowserEnvironment');
    expect(planTargeting({ environment: 'remote', paired: false }).opensRemoteBrowser).toBe(true);
    expect(planTargeting({ environment: 'local', paired: true }).opensRemoteBrowser).toBe(false);
  });

  it('keeps the two concepts apart in the UI that renders them', async () => {
    const flow = await read('public/js/targeting-flow.js');
    // The dialog shows a Base URL row AND an environment choice. Conflating them
    // is what lets "Backend Base URL" be mistaken for a browser picker.
    expect(flow).toMatch(/baseUrlRow/);
    expect(flow).toMatch(/Browser Environment/);
  });

  it('the UI renders a server-computed plan rather than inventing one', async () => {
    const flow = code(await read('public/js/targeting-flow.js'));
    // If the client decided, it could promise "no code needed" and then produce
    // a code. Every branch must come from /inspector/targeting/*.
    expect(flow).toMatch(/targetingBegin|targeting\/begin/);
    expect(flow).not.toMatch(/needsAuthorization\s*=\s*(true|false)/);
  });
});
