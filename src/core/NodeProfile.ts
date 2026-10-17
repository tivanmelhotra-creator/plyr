/**
 * NodeProfile — the browser profile chosen ON a Launch Browser node (phase 2).
 *
 * The workflow setting stays the default; a Launch node may name another
 * profile. A run still uses ONE profile (one lease, taken by the worker BEFORE
 * the run starts), so the choice is resolved up front from the steps:
 *
 *   no Launch node names a profile      -> the workflow's profile (unchanged)
 *   Launch nodes name ONE profile       -> that profile
 *   Launch nodes name DIFFERENT ones    -> refused at validation (not guessed)
 *
 * The same resolution is used by the worker (lease), the reservations
 * (core/ProfileCoordinator) and validation, so a schedule reserves the profile
 * its run will really take. Pure.
 */
import { sanitizeProfileId } from './ProfileLease';

const LAUNCH = /^launch([-_]browser)?$/;
const CHILD_KEYS = ['then', 'else', 'steps', 'catch', 'finally', 'fallback', 'errorSteps', 'timeoutSteps'] as const;

/** Every profile id named by an enabled Launch node, in order, de-duplicated. */
export function launchProfilesOf(steps: unknown): string[] {
  const out: string[] = [];
  let budget = 20_000;
  const walk = (list: unknown, depth: number): void => {
    if (!Array.isArray(list) || depth > 24) return;
    for (const s of list) {
      if (budget-- <= 0 || !s || typeof s !== 'object') continue;
      const st = s as Record<string, any>;
      if (st.disabled !== true && typeof st.action === 'string' && LAUNCH.test(st.action)) {
        const raw = st.params?.profileId;
        if (typeof raw === 'string' && raw.trim()) {
          const id = sanitizeProfileId(raw.trim());
          if (id && !out.includes(id)) out.push(id);
        }
      }
      for (const k of CHILD_KEYS) walk(st[k], depth + 1);
      for (const p of Array.isArray(st.paths) ? st.paths : []) walk(p?.steps, depth + 1);
      if (st.cases && typeof st.cases === 'object') for (const v of Object.values(st.cases)) walk(v, depth + 1);
    }
  };
  walk(steps, 0);
  return out;
}

/** The profile a run of these steps uses: the Launch node's, else the workflow's. */
export function runProfileIdOf(steps: unknown, workflowProfileId: string | null | undefined): string | null {
  const named = launchProfilesOf(steps);
  if (named.length) return named[0]!;
  return workflowProfileId ?? null;
}
