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
// The requirement is a decision table, and decision tables fail quietly.
//
//   LOCAL  = the SERVER-LOCAL browser runtime. The browser runs on the SAME
//            server/infrastructure as Plyr, so the binding is internal and
//            automatic: no Base URL, no API Key, no Authorization Code is
//            ever asked for. The planner must NEVER route a usable LOCAL to
//            the legacy `authorize` step — that step implemented the rejected
//            PR16 model (LOCAL = the user's own browser elsewhere, paired by
//            a typed code) and is gone from this contract.
//   REMOTE = the server-owned Chromium. Same conclusion, plus the browser
//            itself is opened. Remote Approval (the consent prompt) is
//            REMOTE-only; nothing here may produce it for LOCAL.
//
// `planTargeting` is pure, so every branch can be pinned down here with no
// browser, no socket and no clock.
//
// The cases the operator stated in prose are marked [REQ].
// ════════════════════════════════════════════════════════════════

describe('the two environments, and nothing else', () => {
  it('offers exactly LOCAL and REMOTE', () => {
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
    expect(plan.serverMayGrant).toBe(true);
    expect(plan.note).toBe('server_owned_browser');
  });
});

describe('LOCAL BROWSER — the SERVER-LOCAL runtime, automatic and codeless', () => {
  // [REQ] «LOCAL UI نباید این موارد را داشته باشد: Base URL / API Key /
  //        Authorization Code / Remote Approval — و کاربر نباید هیچ‌کدام را
  //        وارد کند.»
  it('NEVER asks for an Authorization Code — not even the first time', () => {
    const plan = planTargeting({ environment: 'local', paired: false });
    // The single most important assertion in this file: the legacy `authorize`
    // step must not be produced for a usable LOCAL, by any path.
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('server_local_browser');
  });

  // [REQ] «دفعات بعد برای همان Extension و همان Target Field، دیگر
  //        Authorization Code لازم نیست.» — trivially true now: there is none.
  it('stays on targeting once that field is already paired', () => {
    const plan = planTargeting({ environment: 'local', paired: true });
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('already_paired');
  });

  it('never opens the server browser', () => {
    // LOCAL does not mean "open a second window on the server" — the runtime
    // is already there. A window the user did not ask for is both useless and
    // confusing.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).opensRemoteBrowser).toBe(false);
    }
  });

  it('lets the server bind internally, exactly like REMOTE', () => {
    // One machine, one token, no trust gap — the same property that made
    // REMOTE codeless. serverMayGrant is what the begin route reads to decide
    // it may grant the binding itself instead of minting a code.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).serverMayGrant).toBe(true);
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
    expect(plan.opensRemoteBrowser).toBe(false);
    // Disabled is NOT a code problem: needsAuthorization stays false, because
    // typing a code would not turn the runtime on.
    expect(plan.needsAuthorization).toBe(false);
  });

  it('reports local_unavailable when local is on but nothing is connected', () => {
    const plan = planTargeting({ environment: 'local', paired: false, localAvailable: false });
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_unavailable');
    expect(plan.needsAuthorization).toBe(false);
  });

  it('prefers local_disabled when both are false', () => {
    const plan = planTargeting({
      environment: 'local', paired: false, localEnabled: false, localAvailable: false,
    });
    expect(plan.note).toBe('local_disabled');
  });

  it('still refuses rather than re-pairing a paired-but-unreachable field', () => {
    // Unreachable is not "unpaired". Conflating them would throw away a
    // binding the user already has, just because the runtime is down.
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

  it('warns about NOTHING — neither environment ever asks for a code', () => {
    // The inversion this change exists to pin: LOCAL used to carry
    // needsAuthorization:true. Now no option does, so the chooser can never
    // advertise a code the contract forbids.
    const [local, remote] = environmentOptions({ paired: false });
    expect(local.needsAuthorization).toBe(false);
    expect(remote.needsAuthorization).toBe(false);
  });

  it('marks an already-paired LOCAL field as paired', () => {
    const [local] = environmentOptions({ paired: true });
    expect(local.needsAuthorization).toBe(false);
    expect(local.paired).toBe(true);
  });

  it('treats REMOTE as always paired', () => {
    const [, remote] = environmentOptions({ paired: false });
    expect(remote.paired).toBe(true);
  });

  it('marks LOCAL unavailable, with the reason, when it is off', () => {
    const [local, remote] = environmentOptions({ paired: false, localEnabled: false });
    expect(local.available).toBe(false);
    expect(local.note).toBe('local_disabled');
    expect(remote.available).toBe(true);
    expect(remote.note).toBe('');
  });

  it('never disagrees with what selecting it would actually do', () => {
    // A dialog promising "nothing needed" that then produced a code screen
    // would be worse than no dialog, so the options are GENERATED from
    // planTargeting — and this case fails if the two ever drift.
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
