import { describe, it, expect } from 'vitest';
import {
  BROWSER_ENVIRONMENTS,
  isBrowserEnvironment,
  normalizeBrowserEnvironment,
  planTargeting,
  environmentOptions,
} from '../../src/core/BrowserEnvironment';

// ════════════════════════════════════════════════════════════════
// BrowserEnvironment — the LOCAL / REMOTE branch at the top of Targeting.
//
// WHAT THIS FILE IS ACTUALLY PROTECTING
// -------------------------------------
// The requirement is a decision table, and decision tables fail quietly. The
// two ways to get it wrong are symmetrical and both invisible at a glance:
//
//   * ask for an Authorization Code when one is not needed — the papercut the
//     user complained about, a code on every single re-open;
//   * skip a code when one IS needed — which would mean an unpaired extension
//     silently writing into a field.
//
// `planTargeting` is pure, so every branch can be pinned down here with no
// browser, no socket and no clock. That is the whole reason it was written as a
// total function instead of being spread across the routes.
//
// The cases the operator stated in prose are marked [REQ].
// ════════════════════════════════════════════════════════════════

describe('the two environments, and nothing else', () => {
  it('offers exactly LOCAL and REMOTE', () => {
    // Not a tautology: the requirement names two options and the chooser is
    // generated from this list, so a third sneaking in would show up on screen.
    expect([...BROWSER_ENVIRONMENTS]).toEqual(['local', 'remote']);
  });

  it('recognises only those two as environments', () => {
    expect(isBrowserEnvironment('local')).toBe(true);
    expect(isBrowserEnvironment('remote')).toBe(true);
    expect(isBrowserEnvironment('auto')).toBe(false);
    expect(isBrowserEnvironment('')).toBe(false);
    expect(isBrowserEnvironment(undefined)).toBe(false);
    expect(isBrowserEnvironment(null)).toBe(false);
    expect(isBrowserEnvironment(1)).toBe(false);
  });
});

describe('coercing a request body into an environment', () => {
  it('accepts the exact values', () => {
    expect(normalizeBrowserEnvironment('local')).toBe('local');
    expect(normalizeBrowserEnvironment('remote')).toBe('remote');
  });

  it('tolerates the casing and padding a form control produces', () => {
    expect(normalizeBrowserEnvironment(' LOCAL ')).toBe('local');
    expect(normalizeBrowserEnvironment('Remote')).toBe('remote');
  });

  it('falls back to REMOTE for anything unrecognised', () => {
    // Remote is the environment with no prerequisites — no extension, no agent,
    // no pairing. Degrading into it is honest; degrading into `local` would
    // promise a browser that may not be there.
    expect(normalizeBrowserEnvironment(undefined)).toBe('remote');
    expect(normalizeBrowserEnvironment(null)).toBe('remote');
    expect(normalizeBrowserEnvironment('nonsense')).toBe('remote');
    expect(normalizeBrowserEnvironment({})).toBe('remote');
  });

  it('lets a caller name its own fallback', () => {
    expect(normalizeBrowserEnvironment('nonsense', 'local')).toBe('local');
  });
});

describe('REMOTE BROWSER', () => {
  // [REQ] «برای REMOTE BROWSER نیازی به Authorization Code نیست.»
  it('never asks for an Authorization Code', () => {
    for (const paired of [true, false]) {
      const plan = planTargeting({ environment: 'remote', paired });
      expect(plan.step).toBe('targeting');
      expect(plan.needsAuthorization).toBe(false);
    }
  });

  it('goes straight to targeting even when local is off or unreachable', () => {
    // Remote must not be collateral damage from the local switch: those flags
    // describe a browser remote does not use.
    const plan = planTargeting({
      environment: 'remote',
      paired: false,
      localEnabled: false,
      localAvailable: false,
    });
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
  });

  it('opens the server browser, and lets the server bind without a code', () => {
    const plan = planTargeting({ environment: 'remote', paired: false });
    expect(plan.opensRemoteBrowser).toBe(true);
    // Not a shortcut — the server launched that Chromium and seeded the
    // extension inside it with its own token, so there is only one machine and
    // no trust gap for a code to bridge.
    expect(plan.serverMayGrant).toBe(true);
    expect(plan.note).toBe('server_owned_browser');
  });
});

describe('LOCAL BROWSER', () => {
  // [REQ] First use of a field: the code is issued at that moment.
  it('asks for an Authorization Code the FIRST time a field is targeted', () => {
    const plan = planTargeting({ environment: 'local', paired: false });
    expect(plan.step).toBe('authorize');
    expect(plan.needsAuthorization).toBe(true);
    expect(plan.note).toBe('pairing_required');
  });

  // [REQ] «دفعات بعد برای همان Extension و همان Target Field، دیگر
  //        Authorization Code لازم نیست.»
  it('asks for NOTHING once that field is already paired', () => {
    const plan = planTargeting({ environment: 'local', paired: true });
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('already_paired');
  });

  it('never opens the server browser', () => {
    // The bug this whole change exists to fix: the user already has the page
    // open in their own Chrome, and a server window they did not ask for is
    // both useless and confusing.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).opensRemoteBrowser).toBe(false);
    }
  });

  it('never lets the server bind on the user’s behalf', () => {
    // The server does not own the user's browser, so it cannot vouch for what
    // is running in it. Only a code the human types can.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).serverMayGrant).toBe(false);
    }
  });
});

describe('LOCAL when it cannot be used', () => {
  it('reports local_disabled WITHOUT silently switching to remote', () => {
    const plan = planTargeting({ environment: 'local', paired: false, localEnabled: false });
    // The environment stays `local`. A silent downgrade would tell the user
    // "Targeting" while the server pointed a different browser at a different
    // page — the exact lie this subsystem exists to prevent.
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_disabled');
    expect(plan.step).toBe('authorize');
    expect(plan.opensRemoteBrowser).toBe(false);
  });

  it('reports local_unavailable when local is on but nothing is connected', () => {
    const plan = planTargeting({ environment: 'local', paired: false, localAvailable: false });
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_unavailable');
  });

  it('prefers local_disabled when both are false', () => {
    // "Turned off on this server" is actionable by the operator; "nothing
    // connected" is actionable by the user. Naming the outer cause first sends
    // them to the right place.
    const plan = planTargeting({
      environment: 'local', paired: false, localEnabled: false, localAvailable: false,
    });
    expect(plan.note).toBe('local_disabled');
  });

  it('still says a paired field would need no code, even while unreachable', () => {
    // Unreachable is not "unpaired". Conflating them would throw away a pairing
    // the user already earned, just because their browser was closed.
    const plan = planTargeting({ environment: 'local', paired: true, localAvailable: false });
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('local_unavailable');
  });
});

describe('an unrecognised environment', () => {
  it('is planned as REMOTE rather than crashing or guessing local', () => {
    const plan = planTargeting({
      environment: 'sideways' as unknown as 'local', paired: false,
    });
    expect(plan.environment).toBe('remote');
    expect(plan.needsAuthorization).toBe(false);
  });
});

describe('the chooser’s options', () => {
  it('lists both environments, in the requirement’s order', () => {
    const opts = environmentOptions({ paired: false });
    expect(opts.map((o) => o.id)).toEqual(['local', 'remote']);
  });

  it('warns that LOCAL will ask for a code, when it will', () => {
    const [local, remote] = environmentOptions({ paired: false });
    expect(local.needsAuthorization).toBe(true);
    expect(remote.needsAuthorization).toBe(false);
  });

  it('drops that warning once the field is paired', () => {
    const [local] = environmentOptions({ paired: true });
    expect(local.needsAuthorization).toBe(false);
    expect(local.paired).toBe(true);
  });

  it('treats REMOTE as always paired', () => {
    // Truthful rather than cosmetic: the server grants the binding itself, so
    // from the user's side there is nothing left to do.
    const [, remote] = environmentOptions({ paired: false });
    expect(remote.paired).toBe(true);
  });

  it('marks LOCAL unavailable, with the reason, when it is off', () => {
    const [local, remote] = environmentOptions({ paired: false, localEnabled: false });
    expect(local.available).toBe(false);
    expect(local.note).toBe('local_disabled');
    // …and remote is untouched, so the user always has a way forward.
    expect(remote.available).toBe(true);
    expect(remote.note).toBe('');
  });

  it('never disagrees with what selecting it would actually do', () => {
    // The property that matters most. A dialog promising "no code needed" that
    // then produced one would be worse than no dialog, so the options are
    // GENERATED from planTargeting rather than written alongside it — and this
    // case fails if the two ever drift.
    for (const paired of [true, false]) {
      for (const localEnabled of [true, false]) {
        const opts = environmentOptions({ paired, localEnabled });
        for (const opt of opts) {
          const plan = planTargeting({ environment: opt.id, paired, localEnabled });
          expect(opt.needsAuthorization).toBe(plan.needsAuthorization);
        }
      }
    }
  });
});
