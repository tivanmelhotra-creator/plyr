/**
 * session-expiry.test.ts — the emulated browser must not die while it is being
 * used, and when it does die the user must be able to tell.
 *
 * THE REPORT (Ask #13, issue B)
 * -----------------------------
 * «وقتی روی تب های مختلف کار میکنم یا حتی روی یک تب هم باشم وقتی چند بار
 * اسکرول میکنم و یا کلا کار های وب گردی مرورگز شبیه ساز ما کرش میکنه و چاره ای
 * نمیزاره و مجبورم میکنه یبار ببندم مجدد بازش کنم»
 *
 * and the decisive refinement:
 *
 * «بیشتر اوقات اینجوریه که وقتی کرش میکنه انگار ارتباطش با مروگز اصلی پلی رایت
 * قطه میشه انگار چون بعدش حتی نمیشه به تب دیگه یا تب جدید رفت و حتی سرچ کنی …
 * و نکته اینکه وقتی ریستارت میزنم یا میبندم باز میکنم درست میشه ولی بعد وبگردی
 * اندکی باز همون میشه»
 *
 * THE MEASUREMENT — reproduced end to end through the real WebSocket
 * ------------------------------------------------------------------
 * A client connected, navigated, and then did what a reader does: nothing.
 *
 *     after 300s of reading: expired = YES
 *     socket readyState    = 1 (OPEN)
 *       tabNew   -> NO ANSWER (silently dropped)
 *       navigate -> NO ANSWER (silently dropped)
 *       ping     -> NO ANSWER (silently dropped)
 *
 * Every symptom in the report follows from those two lines. The SESSION closed
 * on its idle timer, but the SOCKET stayed open, and `handleCommand` opens with
 * `if (session.isClosed()) return;` — so from that instant every command the
 * user sent was discarded in silence while the UI still read "connected" and
 * the canvas still showed its last frame. Closing and reopening the window was
 * the only cure, which is exactly what the user described doing.
 *
 * Ruled out first, by measurement, so the real cause could be found:
 *   - CDP is NOT wedged: behind a flood of 270 wheel events an unrelated
 *     command still answered in 71ms and `page.title()` in 2ms.
 *   - The channel is NOT dead: after a flood, isConnected / title / evaluate /
 *     newPage / goto / newCDPSession / bringToFront all still worked.
 *   - Acks are NOT starving: 47 acks sent, 0 failed.
 *   - Not a leak: an apparent slowdown was tab accumulation, not a leak.
 *
 * TWO FAULTS, TWO FIXES, BOTH CHECKED HERE
 * ----------------------------------------
 *   1. WATCHING WAS NOT ACTIVITY. `touch()` runs on COMMANDS only, so a user
 *      reading a page or watching a video was counted as idle and reaped
 *      mid-view. Frames now count as use (§2).
 *   2. EXPIRY WAS INVISIBLE. Even a genuinely idle session must not become a
 *      socket that accepts commands and ignores them. The socket is now closed
 *      with the session, so the client gets a real disconnect (§3).
 *
 * These tests drive the REAL LiveBrowserSession and the REAL sink wiring with
 * fake timers. Nothing is asserted about the text of the source.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LiveBrowserManager, LiveBrowserSession } from '../../src/core/LiveBrowser';
import { BrowserStreamServer } from '../../src/core/BrowserStreamServer';

const IDLE_TTL_MS = 5 * 60 * 1000;

/**
 * Every manager this file builds, so `afterEach` can shut them down.
 *
 * The suite runs with `pool: 'forks', singleFork: true` (vitest.config.ts), so
 * all 63 test files share ONE process: anything left running here is still
 * running while later files execute. Sessions are closed, spies restored and
 * the clock handed back on every single test, in that order.
 */
const managers: LiveBrowserManager[] = [];

function manager(max = 4): LiveBrowserManager {
  const mgr = new LiveBrowserManager(max);
  managers.push(mgr);
  return mgr;
}

/** Capture every event a session emits, the way the socket layer does. */
function watch(session: LiveBrowserSession): string[] {
  const seen: string[] = [];
  session.setSinks(
    () => { /* frames are counted separately where it matters */ },
    (type) => { seen.push(type); },
  );
  return seen;
}

/**
 * Start the idle clock the way a user's first command does.
 *
 * The clock is armed by `touch()`, which is private and is reached through a
 * command. Which command matters, and MEASURED (probe, this session) it is not
 * the obvious one:
 *
 *   ping()             -> did NOT settle in 50ms; emitted 'recovering'
 *   selectTab('nope')  -> settled immediately; idleTimer armed
 *
 * `ping()` finds no live page on a session that was never started, so it falls
 * into `recover()` and tries to launch a real Chrome — which under fake timers
 * never comes back. `selectTab` with an id that does not exist touches first and
 * then returns at its `!tab` guard, so it arms the clock and touches no browser.
 * That is the whole reason this helper exists rather than an inline call.
 */
async function arm(session: LiveBrowserSession): Promise<void> {
  await session.selectTab('no-such-tab');
}

afterEach(async () => {
  // Sessions are closed while the fake clock is still installed: `close()`
  // awaits teardown that would otherwise sit waiting on real time.
  await Promise.all(managers.splice(0).map((m) => m.shutdown().catch(() => {})));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('§1 the bug, reproduced: an idle session goes quiet and stays quiet', () => {
  it('closes itself after the idle deadline and announces it', async () => {
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u1');
    const seen = watch(s);

    await arm(s);
    expect(s.isClosed()).toBe(false);

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 1000);

    expect(seen).toContain('expired');
    expect(s.isClosed()).toBe(true);
  });

  it('and once closed it silently ignores every command — the reported symptom', async () => {
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u2');
    await arm(s);
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 1000);
    expect(s.isClosed()).toBe(true);

    // This is what the user experienced: the calls do not throw, they do
    // nothing. Which is why the window looked alive and answered nothing.
    const after = watch(s);
    await s.newTab('https://example.com/');
    await s.selectTab('t1');
    await s.ping();
    expect(after).toEqual([]);
  });
});

describe('§2 watching is activity: a session being streamed is not idle', () => {
  it('a frame delivered before the deadline pushes the deadline out', async () => {
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u3');
    const seen = watch(s);
    await arm(s);

    const frame = await frameDeliverer(s);

    // The user watches for most of the TTL without touching anything, which is
    // what reading a long page or watching a video looks like.
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS - 20_000);
    expect(seen).not.toContain('expired');

    // One frame goes out to the viewer.
    await frame();

    // Past the ORIGINAL deadline: without the fix this had already expired.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(seen).not.toContain('expired');
    expect(s.isClosed()).toBe(false);
  });

  it('continuous watching keeps a session alive well past the TTL', async () => {
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u4');
    const seen = watch(s);
    await arm(s);

    const frame = await frameDeliverer(s);

    // Twenty minutes of viewing, a frame a second — four times the old TTL.
    for (let i = 0; i < 20 * 60; i++) {
      await frame();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(seen).not.toContain('expired');
    expect(s.isClosed()).toBe(false);
  });

  it('but a session nobody is watching still expires', async () => {
    // The idle reaper must keep working: this is a shared server, and a window
    // left open on a dead tab must not hold a real Chrome forever.
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u5');
    const seen = watch(s);
    await arm(s);

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 1000);

    expect(seen).toContain('expired');
    expect(s.isClosed()).toBe(true);
  });

  it('the frame path is cheap: a burst of frames re-arms the deadline once', async () => {
    // Making watching count is only affordable if it is throttled: the
    // screencast runs at up to 60 frames a second, and re-arming a timer on
    // every one of them would replace an idle-timeout bug with a churn bug.
    //
    // The throttle is observed through `lastActivityAt`, the stamp `touch()`
    // writes. A frame the throttle swallows leaves it untouched; a frame it
    // lets through moves it. That is the same fact a timer counter would give,
    // WITHOUT patching the global `setTimeout` — which was tried first and had
    // to be abandoned: this suite runs `singleFork`, so all 63 files share one
    // process, and the patch leaked into five unrelated files whose real waits
    // then never elapsed (eight tests hanging at exactly 15000ms).
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u6');
    watch(s);
    await arm(s);
    const frame = await frameDeliverer(s);
    const stamp = () => (s as unknown as { lastActivityAt: number }).lastActivityAt;

    // Step past the throttle window opened by `arm()` itself, so the first
    // frame of the burst is one the throttle is willing to let through. (Found
    // by measurement: without this the burst re-armed 0 times, not 1, because
    // the arming command had just refreshed the activity stamp.)
    await vi.advanceTimersByTimeAsync(31_000);

    // A burst of 500 frames, all inside one 30s throttle window.
    const before = stamp();
    await frame();
    const afterFirst = stamp();
    expect(afterFirst).toBeGreaterThan(before);   // the first frame counted

    for (let i = 0; i < 499; i++) await frame();
    expect(stamp()).toBe(afterFirst);             // the other 499 cost nothing

    // Past the throttle window, a frame is allowed to count again — the
    // throttle must delay the touch, not suppress it forever, or a long watch
    // would still be reaped.
    await vi.advanceTimersByTimeAsync(31_000);
    await frame();
    expect(stamp()).toBeGreaterThan(afterFirst);
  });

  it('a frame still reaches the viewer: throttling activity must not drop pixels', async () => {
    // The throttle guards the TIMER, not the stream. If it ever started
    // swallowing frames the canvas would freeze — the very symptom being fixed.
    vi.useFakeTimers();
    const mgr = manager();
    const s = mgr.create('u9');
    const frames: unknown[] = [];
    s.setSinks((f) => { frames.push(f); }, () => {});
    await arm(s);
    const frame = await frameDeliverer(s);

    for (let i = 0; i < 10; i++) await frame();

    expect(frames).toHaveLength(10);
  });
});

/**
 * A stand-in for the client's WebSocket, recording what the server does to it.
 *
 * Only the four members BrowserStreamServer actually uses are implemented, and
 * `readyState` starts OPEN(1) because that is the state the measurement found
 * the real socket in when the session died underneath it.
 */
function fakeSocket() {
  const sent: Array<Record<string, unknown>> = [];
  const closes: Array<{ code: number; reason: string }> = [];
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    readyState: 1,
    sent,
    closes,
    send(raw: string) { sent.push(JSON.parse(raw)); },
    close(code: number, reason: string) {
      closes.push({ code, reason });
      this.readyState = 3;
    },
    on(ev: string, fn: (...a: unknown[]) => void) {
      const l = listeners.get(ev) || [];
      l.push(fn);
      listeners.set(ev, l);
    },
  };
}

describe('§3 a dead session must not leave a live-looking socket', () => {
  it('BrowserStreamServer closes the real socket with 4000 when the session expires', async () => {
    // This drives the REAL BrowserStreamServer.onConnection, so the wiring
    // under test is the shipped wiring. Only two things are stood in for: the
    // socket (an object, because a real one needs a network) and
    // `session.start()` (which would launch Chrome). Everything the assertion
    // depends on — the sink the server installs, the session's own idle timer,
    // the close code — is production code running for real.
    vi.useFakeTimers();
    const mgr = manager();
    const server = new BrowserStreamServer(mgr);

    let session!: LiveBrowserSession;
    const realCreate = mgr.create.bind(mgr);
    vi.spyOn(mgr, 'create').mockImplementation((uid: string) => {
      session = realCreate(uid);
      // The browser launch is the ONLY thing neutralised. `start()` normally
      // ends with a touch() that arms the idle clock, so that is kept: without
      // it this would be testing a session whose clock never started.
      vi.spyOn(session, 'start').mockImplementation(async () => {
        await session.selectTab('no-such-tab');
      });
      return session;
    });

    const ws = fakeSocket();
    await (server as unknown as {
      onConnection: (ws: unknown, userId: string) => Promise<void>;
    }).onConnection(ws, 'u7');

    // Connected and healthy: nothing has closed the socket.
    expect(ws.closes).toEqual([]);
    expect(ws.readyState).toBe(1);

    // The user reads for five minutes and sends nothing.
    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 1000);

    // Before the fix this is where the measurement found readyState 1 with a
    // dead session behind it. Now the client gets a real disconnect it can act
    // on, carrying a code that says which disconnect it was.
    expect(session.isClosed()).toBe(true);
    expect(ws.closes).toHaveLength(1);
    expect(ws.closes[0].code).toBe(4000);
    expect(ws.closes[0].reason).toBe('session_expired');
    expect(ws.readyState).toBe(3);
  });

  it('and the client is told before the socket goes, not after', async () => {
    // Ordering matters: a close with no preceding `expired` event leaves the
    // client guessing why it was disconnected, which is the ambiguity the fix
    // exists to remove.
    vi.useFakeTimers();
    const mgr = manager();
    const server = new BrowserStreamServer(mgr);

    const realCreate = mgr.create.bind(mgr);
    vi.spyOn(mgr, 'create').mockImplementation((uid: string) => {
      const s = realCreate(uid);
      vi.spyOn(s, 'start').mockImplementation(async () => {
        await s.selectTab('no-such-tab');
      });
      return s;
    });

    const ws = fakeSocket();
    await (server as unknown as {
      onConnection: (ws: unknown, userId: string) => Promise<void>;
    }).onConnection(ws, 'u8');

    await vi.advanceTimersByTimeAsync(IDLE_TTL_MS + 1000);

    const types = ws.sent.map((m) => m.t);
    expect(types).toContain('expired');
    expect(ws.closes).toHaveLength(1);
  });
});

/**
 * Install the session's REAL `Page.screencastFrame` handler and return a
 * function that fires it, exactly as Chromium would.
 *
 * WHY THIS IS NOT SHORTER. The first version of this helper called the
 * session's private `noteWatched()` directly and then poked the frame sink. It
 * passed, and it was worthless: MEASURED by mutation, deleting `noteWatched()`
 * from the production frame path left all eight tests green. The helper was
 * re-implementing the very line under test, so it could only ever confirm
 * itself.
 *
 * The handler lives inside `bindCdp`, registered with `cdp.on(...)`. So
 * `bindCdp` is called for real, against a CDP double that records the handler
 * and answers the two protocol calls it makes (`Page.startScreencast` and, per
 * frame, `Page.screencastFrameAck`). Everything after that registration —
 * whether a frame counts as activity, whether it is throttled, what reaches the
 * sink — is production code. Kill the fix and these tests now fail.
 */
async function frameDeliverer(
  session: LiveBrowserSession,
): Promise<() => Promise<void>> {
  let onFrame: ((p: unknown) => unknown) | null = null;
  const sent: string[] = [];

  const cdp = {
    on(event: string, fn: (p: unknown) => unknown) {
      if (event === 'Page.screencastFrame') onFrame = fn;
    },
    async send(method: string) { sent.push(method); },
    async detach() { /* nothing to detach */ },
  };

  const inner = session as unknown as {
    context: unknown;
    bindCdp: (page: unknown) => Promise<void>;
  };
  // `bindCdp` returns early without a context, and reaches its CDP through
  // `context.newCDPSession(page)`. That one factory call is the seam.
  const page = { isClosed: () => false };
  inner.context = { newCDPSession: async () => cdp };
  await inner.bindCdp(page);

  if (!onFrame) throw new Error('bindCdp did not register a screencast handler');
  // Proves the seam actually reached the production path rather than silently
  // returning early — otherwise a refactor could quietly empty these tests.
  expect(sent).toContain('Page.startScreencast');

  let seq = 0;
  return async () => {
    seq += 1;
    await onFrame!({
      data: '',
      sessionId: seq,
      metadata: { deviceWidth: 1280, deviceHeight: 720 },
    });
  };
}
