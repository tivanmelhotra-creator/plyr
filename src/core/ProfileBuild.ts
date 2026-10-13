/**
 * ProfileBuild — what each live profile browser was STARTED with, shared by
 * every launcher of a profile browser (core/ProfileBrowser for the operator,
 * pipeline.ensureProfileBrowser for runs).
 *
 * A profile browser is reused while it is open. Before this module only the
 * pipeline recorded its build; a browser opened by hand had no record, so the
 * next manual run on that profile always saw "built differently" and tried to
 * relaunch it — refused while the operator's view depends on it. Now both
 * write here, in one format:
 *
 *   `<run-options-hash>|headless=<0|1>|launch=<launch-settings-hash>`
 *
 * Compatibility (may a run reuse the browser?):
 *   - visibility must match (manual = visible, scheduled = hidden);
 *   - a run WITH Launch Browser options needs exactly its options;
 *   - a run WITHOUT options accepts any launch settings the operator chose
 *     (they change how the window starts, not the profile's data).
 */
const builds = new Map<string, string>();

export function buildKey(parts: { optionsHash?: string; headless: boolean; launchHash?: string }): string {
  return `${parts.optionsHash || ''}|headless=${parts.headless ? 1 : 0}|launch=${parts.launchHash || ''}`;
}

function split(k: string): { options: string; headless: string; launch: string } {
  const [options = '', headless = '', launch = ''] = String(k || '').split('|');
  return { options, headless, launch: launch.replace(/^launch=/, '') };
}

/** Pure: may a browser built as `existing` serve a run that wants `want`? */
export function buildCompatible(existing: string | undefined | null, want: string): boolean {
  if (!existing) return false;
  if (existing === want) return true;
  const e = split(existing); const w = split(want);
  if (e.headless !== w.headless) return false;
  if (w.options === '' && w.launch === '') return true; // the run asks for nothing specific
  return e.options === w.options && e.launch === w.launch;
}

export function getBuild(leaseId: string): string | undefined { return builds.get(leaseId); }
export function setBuild(leaseId: string, key: string): void { builds.set(leaseId, key); }
export function forgetBuild(leaseId: string): void { builds.delete(leaseId); }
