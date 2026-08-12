/**
 * BrowserMode — which browser a session drives: the one on the SERVER, or the
 * one on the user's own Windows machine.
 *
 * WHY THIS EXISTS
 * ---------------
 * Until now there was exactly one answer: the browser runs on the server and
 * the user watches it through a screencast (`LiveBrowser`) or noVNC
 * (`DesktopProxy`). That is a real browser and it stays — it is the only thing
 * that works for a queued run at 3am, and for a user whose machine is a phone.
 *
 * But it pays a permanent tax the user feels on every single interaction:
 * every mouse move is a round trip, and every repaint is a JPEG crossing the
 * internet. On the user's own machine, rendering, mouse and keyboard are free
 * and instant.
 *
 * So this project now has TWO official modes, and neither replaces the other:
 *
 *   remote — Chrome/Chromium on the server. Playwright drives it directly.
 *   local  — Chrome/Chromium on the user's Windows box, reached through a
 *            reverse CDP tunnel (see LocalBridge). Playwright drives it too.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS DELIBERATELY NOT
 * --------------------------------------------------
 * This is ONLY the registry: who is in which mode, what the default is, and
 * whether a requested mode is actually available right now. It holds no
 * browsers and knows nothing about CDP.
 *
 * Keeping it that small is the point. `BrowserAdapter` asks this file one
 * question ("which mode is this user in?") and then hands back a plain
 * Playwright `BrowserContext` either way, so the ~3100 lines of node logic in
 * pipeline.ts never learn that local mode exists. A mode registry that also
 * owned connections would have forced every caller to care.
 *
 * WHY IN MEMORY AND NOT REDIS
 * ---------------------------
 * A mode is only meaningful while a *connection* to a browser exists, and a
 * local connection cannot outlive the process that holds its tunnel socket.
 * Persisting "user X prefers local" to Redis would let a fresh process promise
 * a local browser it has no socket to — the exact class of lie R3 forbids. The
 * durable part of the preference is the env default; the live part is per
 * process, next to the sockets it describes.
 */

import { config } from '../config';

/** The two official modes. There is no third, and no 'auto' — see below. */
export type BrowserModeName = 'remote' | 'local';

export const BROWSER_MODES: readonly BrowserModeName[] = ['remote', 'local'] as const;

/** Is this string one of the two modes? Used to validate request bodies. */
export function isBrowserMode(value: unknown): value is BrowserModeName {
  return value === 'remote' || value === 'local';
}

/**
 * Coerce anything into a mode, falling back to the configured default.
 *
 * Deliberately total (never throws): it is called on request bodies and on env
 * strings, and both should degrade to "the safe mode that always works"
 * instead of 500ing a page load.
 */
export function normalizeBrowserMode(
  value: unknown,
  fallback: BrowserModeName = defaultBrowserMode(),
): BrowserModeName {
  if (isBrowserMode(value)) return value;
  const s = String(value ?? '').trim().toLowerCase();
  if (s === 'local') return 'local';
  if (s === 'remote') return 'remote';
  return fallback;
}

/**
 * The mode a user gets before they choose anything.
 *
 * `remote` unless the operator says otherwise, because remote is the mode with
 * no prerequisites: no agent to install, no local Chrome, no tunnel. A default
 * of `local` on a fresh instance would greet every new user with "no local
 * browser is connected", which is a worse first run than a slightly slower one.
 */
export function defaultBrowserMode(): BrowserModeName {
  return normalizeBrowserMode(config.BROWSER_MODE_DEFAULT, 'remote');
}

/** Is the operator allowing local mode at all on this instance? */
export function isLocalModeEnabled(): boolean {
  return config.LOCAL_BROWSER_ENABLED !== false;
}

export interface BrowserModeState {
  /** The mode this user is currently in. */
  mode: BrowserModeName;
  /** When it was last set (epoch ms). 0 = never set, i.e. still the default. */
  since: number;
  /**
   * Why the mode is what it is. A switch that silently did not happen is the
   * worst outcome here, so a rejected or downgraded switch says so out loud and
   * the UI repeats the reason verbatim.
   */
  reason: 'default' | 'user' | 'fallback';
}

/**
 * A switch attempt's full result — not just the resulting mode.
 *
 * `requested !== mode` is precisely the "you asked for local, you got remote"
 * case, and the caller must be able to see it to tell the user. Returning only
 * the final mode would make a refused switch indistinguishable from a
 * successful one, which is how a UI ends up claiming a local browser that is
 * not there.
 */
export interface BrowserModeSwitch extends BrowserModeState {
  requested: BrowserModeName;
  changed: boolean;
  /** A stable key (never a sentence) so the UI can render it in fa + en. */
  note: '' | 'local_disabled' | 'local_unavailable' | 'already_in_mode';
}

/**
 * Can local mode actually serve a session right now?
 *
 * Injected rather than imported so this module stays dependency-free and
 * testable offline: LocalBridge registers the real probe at boot, tests pass
 * their own. The default answer is "no", which is the honest answer for a
 * process where nothing has ever connected.
 */
type LocalAvailabilityProbe = (userId: string) => boolean;
let probeLocalAvailability: LocalAvailabilityProbe = () => false;

export function setLocalAvailabilityProbe(fn: LocalAvailabilityProbe | null): void {
  probeLocalAvailability = typeof fn === 'function' ? fn : () => false;
}

export class BrowserModeRegistry {
  private modes = new Map<string, BrowserModeState>();

  /** The user's current state, materialising the default on first read. */
  get(userId: string): BrowserModeState {
    const existing = this.modes.get(userId);
    if (existing) return { ...existing };
    return { mode: defaultBrowserMode(), since: 0, reason: 'default' };
  }

  /** Shorthand for the common case: just the name. */
  modeOf(userId: string): BrowserModeName {
    return this.get(userId).mode;
  }

  /**
   * Switch a user's mode, refusing (with a reason) rather than lying.
   *
   * Two refusals matter, and both keep the user in `remote` — a mode that
   * works — instead of a mode that would fail on the next click:
   *
   *   local_disabled    — the operator turned local mode off for this instance.
   *   local_unavailable — no local browser agent is connected for this user.
   *
   * Switching to `remote` is never refused. Remote is the floor: it needs
   * nothing from the user's machine, so it must always be reachable, including
   * as the escape hatch from a local browser that just died.
   */
  set(userId: string, requestedRaw: unknown): BrowserModeSwitch {
    const current = this.get(userId);
    const requested = normalizeBrowserMode(requestedRaw, current.mode);

    if (requested === 'local') {
      if (!isLocalModeEnabled()) {
        return { ...current, requested, changed: false, note: 'local_disabled' };
      }
      if (!probeLocalAvailability(userId)) {
        return { ...current, requested, changed: false, note: 'local_unavailable' };
      }
    }

    if (requested === current.mode && current.reason !== 'default') {
      return { ...current, requested, changed: false, note: 'already_in_mode' };
    }

    const next: BrowserModeState = { mode: requested, since: Date.now(), reason: 'user' };
    this.modes.set(userId, next);
    return { ...next, requested, changed: true, note: '' };
  }

  /**
   * Force a user back to remote because local just became impossible (the
   * agent's socket dropped, the tunnel failed to open, Chrome exited).
   *
   * This is the counterpart to refusing a switch: a user already in local mode
   * whose browser disappears must not be left in a mode that cannot serve a
   * single command. The `fallback` reason is what lets the UI say "your local
   * browser disconnected, you are back on the remote one" instead of silently
   * changing under them.
   *
   * Returns true only if it actually moved someone, so callers do not announce
   * a fallback that did not happen.
   */
  fallbackToRemote(userId: string): boolean {
    const current = this.modes.get(userId);
    if (!current || current.mode !== 'local') return false;
    this.modes.set(userId, { mode: 'remote', since: Date.now(), reason: 'fallback' });
    return true;
  }

  /** Everyone currently in local mode — used to fan out a bridge loss. */
  localUsers(): string[] {
    const out: string[] = [];
    for (const [userId, state] of this.modes) {
      if (state.mode === 'local') out.push(userId);
    }
    return out;
  }

  /** Drop a user's override entirely (back to the instance default). */
  reset(userId: string): void {
    this.modes.delete(userId);
  }

  clear(): void {
    this.modes.clear();
  }
}

/**
 * The process-wide registry.
 *
 * A singleton for the same reason GlobalBrowser is one: the thing it describes
 * (live browser connections in THIS process) is itself process-wide, and two
 * registries would disagree about which browser a job should use.
 */
export const browserModes = new BrowserModeRegistry();

/** Everything the UI needs to render the mode switch, in one object. */
export interface BrowserModeReport extends BrowserModeState {
  /** Both modes, always — the switch is a permanent part of the product. */
  modes: BrowserModeName[];
  localEnabled: boolean;
  localAvailable: boolean;
  defaultMode: BrowserModeName;
}

export function reportBrowserMode(userId: string): BrowserModeReport {
  const state = browserModes.get(userId);
  return {
    ...state,
    modes: [...BROWSER_MODES],
    localEnabled: isLocalModeEnabled(),
    localAvailable: isLocalModeEnabled() && probeLocalAvailability(userId),
    defaultMode: defaultBrowserMode(),
  };
}
