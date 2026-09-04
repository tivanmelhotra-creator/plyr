import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import vm from 'vm';

// ════════════════════════════════════════════════════════════════════════════
// ISSUE 1, AT ITS ACTUAL ORIGIN — extension/background.js :: inspectorPair()
//
// REPORTED:
//   «من هنوزم همون مشکل و اروری که موقع اتصال Remote موقع ای که دکمه Connect
//    رو می‌زنم با اینکه همه چیزم درسته هم خود Authorize ام و هم Base URL ام
//    درسته خب بازم همون خطا را بهم برمی‌گردونه خب یعنی وصل نمیشه.»
//
// WHY THIS FILE HAD TO BE WRITTEN, AND WRITTEN SEPARATELY
// ------------------------------------------------------
// The popup half of this fix (a Connect that refuses to submit an empty
// address) lives in popup-auth-fields-persist.test.ts. But the DEFECT the
// operator actually hit was one layer down, in a single expression:
//
//     var base = typedBase || ctx.base;      // ← the bug
//
// and that line was PROVEN untested by mutation: reinstating the faulty version
// left the whole suite green — 27/27 in the popup file, 56/56 in
// popup-inspector-pairing.test.ts. A silently surviving mutant on the exact
// line of the reported bug is the one result that must never be accepted, so
// this file exists to kill it.
//
// WHY THE FALLBACK IS SO HARMFUL *HERE* SPECIFICALLY
// -------------------------------------------------
// inspectorContext() resolves an address in three steps and step 3 MANUFACTURES
// `http://127.0.0.1:<port>`, so `ctx.base` is NEVER empty. That is right for
// every other call in background.js — those are made by an extension the server
// itself seeded, where loopback genuinely IS the backend. It is wrong here, and
// wrong structurally rather than by accident:
//
//     inspectorPair() is the REMOTE path. Its whole premise is that the server
//     is on ANOTHER machine. Loopback on THIS machine is therefore the one
//     address guaranteed not to be the server.
//
// So an empty box did not produce "tell me the address". It produced a POST to a
// port on the operator's own laptop, a refused connection, and — because
// apiFetch() collapses every transport failure to the token 'network' — a
// message blaming the AUTHORIZATION CODE. The operator re-copied a perfectly
// valid code as often as they liked while the request never left their machine.
// That is exactly «همه چیزم درسته … بازم همون خطا».
//
// THE DISTINCTION THE FIX TURNS ON — AND GOT WRONG ONCE
// ----------------------------------------------------
// The first cut refused whenever the box was empty, full stop. It killed the bug
// and broke a TRUE case, which tests/unit/inspector-session-handoff.test.ts
// caught within one run: a SERVER-SEEDED extension carries a real, configured
// address and may redeem a code without anyone retyping it. So what is refused
// is the GUESS, not every resolved address — the line inspectorContext() already
// draws and reports as `baseUrlSource`:
//
//   'bootstrap'    → someone configured this (seeded, or a pair that worked)
//   'server-local' → nobody configured anything; step 3 invented loopback
//
// HOW IT IS TESTED
// ----------------
// The real worker runs in a `vm`, as the established seam harness does, and
// every fetch is recorded. Assertions are about WHICH ADDRESS WAS CONTACTED — an
// observable fact of the network layer, not a string in the source — because a
// source-grep test is what let this line rot in the first place.
// ════════════════════════════════════════════════════════════════════════════

type Listener = (
  msg: Record<string, unknown>,
  sender: unknown,
  respond: (r: unknown) => void,
) => boolean | void;

interface Attempt { url: string; method: string; body: Record<string, unknown> | null; key: string }

/** The address the operator types — a real remote host, never loopback. */
const REMOTE = 'https://panel.example.com';

/**
 * Boot the real background.js over a fetch that records every attempt.
 *
 * `serve` decides what the recorded address replies, so one harness covers both
 * "nothing should have been sent" and "something was sent and came back 4xx".
 * Returning null means nothing is listening — which is what a POST to a dead
 * loopback port actually does.
 */
function boot(opts: {
  storage?: Record<string, unknown>;
  serve?: (a: Attempt) => { status: number; data: unknown } | null;
} = {}) {
  const storage: Record<string, unknown> = { ...(opts.storage || {}) };
  const attempts: Attempt[] = [];
  let listener: Listener | null = null;

  const chrome = {
    runtime: {
      lastError: undefined as unknown,
      onMessage: { addListener: (fn: Listener) => { listener = fn; } },
      onInstalled: { addListener: () => {} },
      getURL: (p: string) => `chrome-extension://test/${p}`,
    },
    storage: {
      local: {
        get(keys: string[] | string, cb: (s: Record<string, unknown>) => void) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const k of list) if (storage[k] !== undefined) out[k] = storage[k];
          cb(out);
        },
        set(patch: Record<string, unknown>, cb?: () => void) {
          Object.assign(storage, patch); if (cb) cb();
        },
        remove(keys: string[] | string, cb?: () => void) {
          const list = Array.isArray(keys) ? keys : [keys];
          for (const k of list) delete storage[k];
          if (cb) cb();
        },
      },
    },
    tabs: {
      query: (_q: unknown, cb: (t: unknown[]) => void) => cb([{ id: 1 }]),
      sendMessage: (_i: number, _m: unknown, cb?: (r: unknown) => void) => { if (cb) cb({ ok: true }); },
      create: (_o: unknown, cb?: (t: unknown) => void) => { if (cb) cb({ id: 2 }); },
    },
    scripting: { executeScript: (_o: unknown, cb?: () => void) => { if (cb) cb(); } },
    commands: { onCommand: { addListener: () => {} } },
    action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} },
  };

  async function fakeFetch(url: string, init: Record<string, unknown> = {}) {
    const headers = (init.headers || {}) as Record<string, string>;
    let body: Record<string, unknown> | null = null;
    if (init.body) { try { body = JSON.parse(String(init.body)); } catch { body = null; } }
    const attempt: Attempt = {
      url: String(url),
      method: String(init.method || 'GET').toUpperCase(),
      body,
      key: headers['x-api-key'] || '',
    };
    attempts.push(attempt);

    const served = opts.serve ? opts.serve(attempt) : null;
    if (served) {
      return {
        ok: served.status >= 200 && served.status < 300,
        status: served.status,
        text: async () => JSON.stringify(served.data),
      };
    }
    // Nothing is listening. Reproducing this faithfully is what makes the
    // "collapsed to 'network'" symptom visible to the test.
    throw new TypeError('Failed to fetch');
  }

  const sandbox: Record<string, unknown> = {
    chrome,
    fetch: fakeFetch,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // Absent in the authored extension — the hand-installed REMOTE case, which
    // is the only case that ever redeems a code.
    importScripts: (file: string) => { throw new Error('not found: ' + file); },
    setTimeout,
    clearTimeout,
    EventSource: function EventSourceStub() {},
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(resolve(__dirname, '../../extension/background.js'), 'utf8'),
    sandbox as never,
    { filename: 'background.js' },
  );
  if (!listener) throw new Error('background.js registered no onMessage listener');

  return {
    storage,
    attempts,
    /** Send AB_INSPECTOR_PAIR the way the popup's Connect button does. */
    pair(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((done) => {
        (listener as Listener)(
          { type: 'AB_INSPECTOR_PAIR', payload },
          {},
          (r) => done((r || {}) as Record<string, unknown>),
        );
      });
    },
  };
}

/** Any address on this machine — the thing that must never be invented here. */
function isLoopback(url: string) {
  return /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)/i.test(url);
}

// ═══════════════════════════════════════════════════════════════════════════
describe('a code is NEVER redeemed against a manufactured address', () => {
  it('THE MUTANT KILLER: an empty Base URL sends no request at all', async () => {
    // The precise state Issue 3a used to produce — a box that cleared itself
    // while the operator was away copying the code. With the fallback present
    // this posted to 127.0.0.1 and reported a bad code.
    const h = boot();
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: '' });

    expect(h.attempts, 'a code must not be sent anywhere until an address is known').toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_base_url');
  });

  it("THE OPERATOR'S OWN INSTALL: a hand-installed copy never invents an address", async () => {
    // The reported configuration, exactly. A REMOTE operator loads the
    // extension unpacked into their OWN Chrome: storage is empty and there is no
    // bootstrap.config.js (importScripts throws, as it does in this harness), so
    // inspectorContext() reaches step 3 and MANUFACTURES http://127.0.0.1:3000 —
    // a port on the operator's own laptop, where no server exists.
    const h = boot();
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: '' });

    expect(
      h.attempts.filter((a) => isLoopback(a.url)),
      'a manufactured loopback address must never be contacted on the REMOTE path',
    ).toEqual([]);
    expect(res.reason).toBe('no_base_url');
  });

  it('and says the ADDRESS is missing — not that the code was rejected', async () => {
    // The half of the bug that cost the operator the most time: a message about
    // the code sends them to re-copy the one input that was already correct.
    const h = boot();
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: '' });
    const msg = String(res.error || '');

    expect(msg).toMatch(/Base URL/i);
    expect(msg).not.toMatch(/code (?:was|is) not accepted|invalid code/i);
  });

  it('a whitespace-only address counts as no address', async () => {
    // Same refusal, via the other way an operator produces "nothing": a box
    // that looks filled but holds only spaces.
    const h = boot();
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: '   ' });
    expect(h.attempts).toEqual([]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no_base_url');
  });

  it('the refusal is about the GUESS, not about every resolved address', async () => {
    // ── THE LINE THIS FIX HAD TO GET RIGHT, AND GOT WRONG ONCE ──────────
    // The first cut refused whenever the box was empty. That killed the bug and
    // broke a TRUE case: a SERVER-SEEDED extension carries a real, configured
    // address and may redeem a code without anyone retyping it. Refusing that
    // would demand the operator hand-type an address the extension was
    // literally installed with.
    //
    // Here the address is CONFIGURED (step 1, `baseUrlSource: 'bootstrap'`) —
    // exactly what a seeded copy has — so the redeem must proceed.
    const h = boot({
      storage: { ab_baseUrl: 'https://configured.example', ab_apiKey: 'ak_live_x' },
      serve: () => ({ status: 200, data: { success: true, clientToken: 'ict_abc' } }),
    });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: '' });

    expect(res.ok, 'a configured address is a legitimate source on this path').toBe(true);
    expect(h.attempts[0].url).toBe('https://configured.example/inspector/pair');
  });

  it('the code is still checked first, so a blank form names the code', async () => {
    // Ordering guard: with BOTH boxes empty the code is the first thing asked
    // for, and no request goes out either way.
    const h = boot();
    const res = await h.pair({ code: '', baseUrl: '' });
    expect(h.attempts).toEqual([]);
    expect(String(res.error || '')).toMatch(/authorization code/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('the typed address is the one that is used', () => {
  it('posts /inspector/pair to the operator-supplied host', async () => {
    const h = boot({
      serve: (a) => (a.url === REMOTE + '/inspector/pair'
        ? { status: 200, data: { success: true, clientToken: 'ict_abc', targetFieldId: 'node_n1__url__a1' } }
        : null),
    });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });

    expect(res.ok).toBe(true);
    const pairPosts = h.attempts.filter((a) => a.url.indexOf('/inspector/pair') >= 0);
    expect(pairPosts).toHaveLength(1);
    expect(pairPosts[0].method).toBe('POST');
    expect(pairPosts[0].url.indexOf(REMOTE)).toBe(0);
  });

  it('the TYPED address outranks a stored one', async () => {
    // The operator is correcting something when they type. A stored address
    // winning would make the box appear to do nothing.
    const h = boot({
      storage: { ab_baseUrl: 'https://stale.example' },
      serve: () => ({ status: 200, data: { success: true, clientToken: 'ict_abc' } }),
    });
    await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(h.attempts[0].url).toBe(REMOTE + '/inspector/pair');
  });

  it('sends the code normalized, as redeem() will compare it', async () => {
    // The dashboard DISPLAYS `ABCD-EFGH`; the server strips non-alphanumerics
    // before comparing. Normalizing here means the string shown is the string
    // compared — so a single-use attempt is never spent on a formatting
    // difference the operator can see but cannot explain.
    const h = boot({
      serve: () => ({ status: 200, data: { success: true, clientToken: 'ict_abc' } }),
    });
    await h.pair({ code: ' abcd-efgh ', baseUrl: REMOTE });
    expect(h.attempts[0].body?.code).toBe('ABCDEFGH');
  });

  it('remembers the address that WORKED, so the next field needs only a code', async () => {
    const h = boot({
      serve: () => ({ status: 200, data: { success: true, clientToken: 'ict_abc' } }),
    });
    await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(h.storage.ab_baseUrl).toBe(REMOTE);
  });

  it('does NOT promote a failed address to ab_baseUrl', async () => {
    // `ab_baseUrl` means "an address that worked". Writing a host that just
    // refused the handshake would repoint every later call the extension makes.
    const h = boot({
      serve: () => ({ status: 404, data: { success: false, error: '' } }),
    });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(res.ok).toBe(false);
    expect(h.storage.ab_baseUrl).toBeUndefined();
  });

  it('stores the client token so later calls can authenticate', async () => {
    // The token is returned exactly once — the server keeps a lookup entry, not
    // a way to re-derive it — so an extension that drops it here must redeem
    // another code to get back in.
    const h = boot({
      serve: () => ({ status: 200, data: { success: true, clientToken: 'ict_5bfb93a' } }),
    });
    await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(h.storage.ab_apiKey).toBe('ict_5bfb93a');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe('Connect explains which of the three things failed', () => {
  it('an unreachable address is reported as unreachable, naming the host', async () => {
    // A typo in a short input box is invisible; echoing the address is what
    // makes it findable. And the code is explicitly still valid — nothing was
    // ever sent, so re-copying it is wasted effort.
    const h = boot({ serve: () => null }); // nothing listening → TypeError
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });

    const msg = String(res.error || '');
    expect(res.ok).toBe(false);
    expect(msg).toContain('panel.example.com');
    expect(msg).toMatch(/still valid|never sent/i);
  });

  it('a 404 says the host answered but is not this application', async () => {
    // The wrong-port / wrong-service case, otherwise indistinguishable from a
    // bad code in the UI.
    const h = boot({ serve: () => ({ status: 404, data: { success: false } }) });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(String(res.error || '')).toMatch(/not (?:this|the) application|reachable/i);
  });

  it('only a 401/403 is allowed to blame the code', async () => {
    // The one case where "that code was not accepted" is the truth.
    const h = boot({ serve: () => ({ status: 403, data: { success: false } }) });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(String(res.error || '')).toMatch(/code/i);
  });

  it("the server's own explanation wins when it sends one", async () => {
    // The server knows things the extension cannot infer — expired, already
    // used, issued for another field. Never paraphrase it.
    const h = boot({
      serve: () => ({
        status: 410,
        data: { success: false, error: 'That code has expired. Generate a new one.' },
      }),
    });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    expect(res.error).toBe('That code has expired. Generate a new one.');
  });

  it('a 5xx blames the server, not the operator', async () => {
    const h = boot({ serve: () => ({ status: 500, data: { success: false } }) });
    const res = await h.pair({ code: 'ABCD-EFGH', baseUrl: REMOTE });
    const msg = String(res.error || '');
    expect(msg).not.toMatch(/invalid code|not accepted/i);
    expect(msg.length).toBeGreaterThan(0);
  });
});
