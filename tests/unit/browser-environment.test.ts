import { describe, it, expect } from 'vitest';
import {
  BROWSER_ENVIRONMENTS,
  isBrowserEnvironment,
  normalizeBrowserEnvironment,
  planTargeting,
  environmentOptions,
} from '../../src/core/BrowserEnvironment';

// ════════════════════════════════════════════════════════════════════════════
// BrowserEnvironment — the LOCAL / REMOTE branch at the top of Targeting.
//
// THE NAMES ARE READ FROM THE PROJECT'S POINT OF VIEW
// ---------------------------------------------------
// Everything in this file follows from that one sentence, and the previous
// revision of these very tests asserted its exact opposite. They passed, because
// the implementation was inverted in the same direction — which is the failure
// mode this file now exists to make impossible:
//
//     «مشکل از پروژه هست که نام گذاری اشتباهی داره — وقتی لوکال میزنم باید
//      مرورگر لوکال سرور بالا بیاد ولی برعکسه»
//
//   LOCAL  = local *to the project*: the browser runtime on the SAME machine as
//            the backend. This server can launch it, so it does. Its address is
//            its own loopback on its own configured port and its credential is
//            its own token, so neither is ever shown to or asked of a human.
//            It DOES raise an in-page approval, because one shared window
//            outlives any single pick and has to be told which field this is.
//
//   REMOTE = remote *from the project*: a browser on the operator's own machine.
//            This server can neither launch it nor vouch for it, so there is a
//            real trust gap: an Authorization Code plus a Base URL. No in-page
//            approval, because the redeemed code already named exactly one field.
//
// WHAT THIS FILE IS ACTUALLY PROTECTING
// -------------------------------------
// The requirement is a decision table, and decision tables fail quietly. There
// are now THREE ways to get it wrong, and the third is the one that shipped:
//
//   * ask for an Authorization Code when one is not needed — a code on every
//     re-open of a browser the server owns, the original papercut;
//   * skip a code when one IS needed — an unvouched-for machine writing into a
//     field;
//   * attach both behaviours to the WRONG environment — which is invisible to
//     any test written in the same inverted vocabulary, and so is deliberately
//     asserted here against the MEANING of each id rather than its label.
//
// `planTargeting` is pure, so every branch is pinned here with no browser, no
// socket and no clock. That is why it was written as a total function instead of
// being spread across the routes.
//
// The cases the operator stated in prose are marked [REQ].
// ════════════════════════════════════════════════════════════════════════════

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
    // REMOTE is the SAFE default, and the reason is the inverse of what the
    // previous comment here claimed. It is not that remote has no
    // prerequisites — it has the most. It is that remote grants nothing without
    // a redeemed code, so a garbled environment field degrades into the branch
    // that asks for proof, never into the branch where the server vouches for
    // the caller by itself.
    expect(normalizeBrowserEnvironment(undefined)).toBe('remote');
    expect(normalizeBrowserEnvironment(null)).toBe('remote');
    expect(normalizeBrowserEnvironment('nonsense')).toBe('remote');
    expect(normalizeBrowserEnvironment({})).toBe('remote');
  });

  it('lets a caller name its own fallback', () => {
    expect(normalizeBrowserEnvironment('nonsense', 'local')).toBe('local');
  });
});

describe('REMOTE BROWSER = a browser on the operator’s OWN machine', () => {
  // [REQ] «ما هم به یک اتورایز نیاز داریم … و هم به یک بیس یو ار ال»
  it('always asks for an Authorization Code, bound or not', () => {
    // Bound-ness does not close a trust gap between two machines. A previously
    // paired field still has to prove the browser redeeming it now is allowed,
    // and a fresh code per field is what keeps the binding attached to the field
    // just picked:
    //
    //     «هر بار فیلد جدید اتورایز جدید باعث شد ما همیشه با فیلد جدید ست بمونیم»
    for (const paired of [true, false]) {
      const plan = planTargeting({ environment: 'remote', paired });
      expect(plan.step).toBe('authorize');
      expect(plan.needsAuthorization).toBe(true);
    }
  });

  it('is not collateral damage from the LOCAL switches', () => {
    // Those two flags describe the SERVER's browser. Remote does not use it, so
    // turning it off must not disable the one path that never needed it.
    const plan = planTargeting({
      environment: 'remote',
      paired: false,
      localEnabled: false,
      localAvailable: false,
    });
    expect(plan.step).toBe('authorize');
    expect(plan.needsAuthorization).toBe(true);
    expect(plan.note).toBe('operator_owned_browser');
  });

  it('launches nothing and grants nothing by itself', () => {
    const plan = planTargeting({ environment: 'remote', paired: false });
    // There is no browser here to launch: it is already running, on a desktop
    // this process cannot reach.
    expect(plan.opensServerBrowser).toBe(false);
    // And the server may not vouch for a machine it has never seen. That is
    // exactly what the code is for.
    expect(plan.serverMayGrant).toBe(false);
    expect(plan.note).toBe('operator_owned_browser');
  });

  it('raises no in-page approval, because the code already named the field', () => {
    // The asymmetry that makes the two prompts non-redundant. A redeemed code
    // names exactly one Target Field, so an in-page question would be a second
    // answer to a settled one.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'remote', paired }).needsInPageApproval).toBe(false);
    }
  });
});

describe('LOCAL BROWSER = the browser runtime on the SAME server', () => {
  // [REQ] "LOCAL باید کاملاً internal/automatic باشد … بدون Base URL، بدون
  // API Key، بدون Authorization Code" — one machine, so the server is not a
  // third party to itself and there is nothing for a human to supply.
  it('asks for no credential the FIRST time a field is targeted', () => {
    const plan = planTargeting({ environment: 'local', paired: false });
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('server_local_browser');
  });

  it('asks for no credential on a field it has already bound either', () => {
    const plan = planTargeting({ environment: 'local', paired: true });
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('already_paired');
  });

  it('LAUNCHES the server’s own browser — the whole point of the name', () => {
    // [REQ] «وقتی لوکال میزنم باید مرورگر لوکال سرور بالا بیاد»
    //
    // This single assertion is the regression that was reported. It used to read
    // `.opensRemoteBrowser).toBe(false)` for local, and the identifier is what
    // made that look right: "opens remote browser" reads as obviously remote's
    // business, so nobody re-checked whether the browser being opened was
    // actually remote. It never was — the only browser this process can start
    // is the one on its own infrastructure.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).opensServerBrowser).toBe(true);
    }
  });

  it('RAISES the in-page approval, whether or not the browser was already up', () => {
    // [REQ] «اگر بالا باشه که الرت میده، اگر بالا نباشه یکی بالا میاره و بعدش الرت میده»
    //
    // Not a trust check — a disambiguation. ONE server browser is shared by
    // every field and outlives any single pick, so nothing in the page it holds
    // says which field the next pick belongs to. A human has to say. Because
    // this plan is the same in both cases, the alert is unconditional here and
    // the launch-vs-reuse decision belongs entirely to the caller.
    for (const paired of [true, false]) {
      expect(planTargeting({ environment: 'local', paired }).needsInPageApproval).toBe(true);
    }
  });

  it('lets the server bind the target itself', () => {
    // The server RUNS this browser, on its own infrastructure, seeded with its
    // own token. Requiring a typed code would ask the operator to copy a secret
    // out of one of the server's windows and back into another of them in order
    // to prove they are themselves.
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
    // page — the exact lie this subsystem exists to prevent. Worse now that the
    // two branches differ: a downgrade would also spring a credential form on
    // somebody who chose the path that has none.
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_disabled');
    // A refusal is NOT an authorize step. The remedy for "switched off" is
    // turning it on, never transcribing a secret — so this stays 'targeting'
    // even though 'authorize' is now expressible.
    expect(plan.step).toBe('targeting');
    expect(plan.needsAuthorization).toBe(false);
    // Nothing is launched and nothing is granted, because the caller 409s here.
    expect(plan.opensServerBrowser).toBe(false);
    expect(plan.serverMayGrant).toBe(false);
    // And no alert is raised in a browser that is not going to exist.
    expect(plan.needsInPageApproval).toBe(false);
  });

  it('reports local_unavailable when local is on but nothing is connected', () => {
    const plan = planTargeting({ environment: 'local', paired: false, localAvailable: false });
    expect(plan.environment).toBe('local');
    expect(plan.note).toBe('local_unavailable');
    expect(plan.opensServerBrowser).toBe(false);
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

  it('still needs no authorization for a bound field, even while unreachable', () => {
    // Unreachable is not "unpaired". Conflating them would throw away a pairing
    // the user already earned, just because their browser was closed — and would
    // do it by demanding a code on the one path that has no code to give.
    const plan = planTargeting({ environment: 'local', paired: true, localAvailable: false });
    expect(plan.needsAuthorization).toBe(false);
    expect(plan.note).toBe('local_unavailable');
  });
});

describe('an unrecognised environment', () => {
  it('is planned as REMOTE — the branch that proves rather than assumes', () => {
    const plan = planTargeting({
      environment: 'sideways' as unknown as 'local', paired: false,
    });
    expect(plan.environment).toBe('remote');
    // And therefore it asks for a code. Garbage in must not reach the branch
    // where the server vouches for the caller on its own authority; making
    // nonsense land on `serverMayGrant: true` would turn a typo into a grant.
    expect(plan.needsAuthorization).toBe(true);
    expect(plan.serverMayGrant).toBe(false);
    expect(plan.opensServerBrowser).toBe(false);
  });
});

describe('the chooser’s options', () => {
  it('lists both environments, in the requirement’s order', () => {
    const opts = environmentOptions({ paired: false });
    expect(opts.map((o) => o.id)).toEqual(['local', 'remote']);
  });

  it('warns about the credential step on REMOTE, and only REMOTE', () => {
    // The card has to say which path leads to a short setup BEFORE the operator
    // commits. This assertion is the exact inverse of what it used to be, and
    // the flip is the fix rather than a relabelling.
    const [local, remote] = environmentOptions({ paired: false });
    expect(local.needsAuthorization).toBe(false);
    expect(remote.needsAuthorization).toBe(true);
  });

  it('marks LOCAL — and only LOCAL — as raising an in-page approval', () => {
    const [local, remote] = environmentOptions({ paired: false });
    expect(local.needsInPageApproval).toBe(true);
    expect(remote.needsInPageApproval).toBe(false);
  });

  it('marks LOCAL — and only LOCAL — as opening the server’s browser', () => {
    // Surfaced on the card so a window appearing on the server is something the
    // operator was told about, not something they discover.
    const [local, remote] = environmentOptions({ paired: false });
    expect(local.opensServerBrowser).toBe(true);
    expect(remote.opensServerBrowser).toBe(false);
  });

  it('treats LOCAL as ready whether or not the field was bound before', () => {
    for (const paired of [true, false]) {
      const [local] = environmentOptions({ paired });
      expect(local.needsAuthorization).toBe(false);
      // serverMayGrant is true for LOCAL, so the card reports it as ready to
      // use rather than as something to set up first.
      expect(local.paired).toBe(true);
    }
  });

  it('reports REMOTE’s REAL pairing state instead of flattering it', () => {
    // The opposite of LOCAL, and deliberately so. On remote the pairing is
    // whatever a redeemed code created, so claiming one exists when it does not
    // would hide the only setup step this product still has.
    expect(environmentOptions({ paired: false })[1].paired).toBe(false);
    expect(environmentOptions({ paired: true })[1].paired).toBe(true);
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
    // The property that matters most, and the one that would have caught the
    // inversion had it covered more than one flag. A dialog promising "no code
    // needed" that then produced one would be worse than no dialog, so the
    // options are GENERATED from planTargeting rather than written alongside
    // it — and every behavioural flag is compared, not just the credential one,
    // because the bug was in the OTHER two.
    for (const paired of [true, false]) {
      for (const localEnabled of [true, false]) {
        for (const localAvailable of [true, false]) {
          const opts = environmentOptions({ paired, localEnabled, localAvailable });
          for (const opt of opts) {
            const plan = planTargeting({
              environment: opt.id, paired, localEnabled, localAvailable,
            });
            expect(opt.needsAuthorization).toBe(plan.needsAuthorization);
            expect(opt.needsInPageApproval).toBe(plan.needsInPageApproval);
            expect(opt.opensServerBrowser).toBe(plan.opensServerBrowser);
          }
        }
      }
    }
  });

  it('never promises both an approval AND a code for the same card', () => {
    // A property rather than a case, and it is the shape of the whole feature:
    // each environment closes its ambiguity exactly once. LOCAL asks a human
    // in-page because a shared window cannot say which field this is; REMOTE
    // carries a code because a foreign machine cannot say who it is. A card
    // offering both would mean one of the two mechanisms had been copied onto an
    // environment that does not need it — which is how the inversion would
    // return, half-applied and passing every other test in this file.
    for (const paired of [true, false]) {
      for (const opt of environmentOptions({ paired })) {
        expect(opt.needsAuthorization && opt.needsInPageApproval).toBe(false);
      }
    }
  });
});
