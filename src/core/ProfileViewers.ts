/**
 * ProfileViewers — the operator's viewer tab of a profile is a DEPENDENT of
 * that profile's browser only while the tab is really connected.
 *
 * POST /profiles/:id/open attaches `operator:<owner>` to the session
 * (core/BrowserSessions). Before this module nothing detached it when the
 * operator simply closed the tab: the browser looked "in use" and the idle
 * collector could never close it until the hold expired.
 *
 * The profile view (/desktop/chrome?profile=<id>&workflowId=<wf>) opens its
 * VNC socket as /desktop/websockify?profile=<id>&workflowId=<wf>. DesktopProxy
 * reports each such socket here; when the LAST socket of (profile, owner)
 * closes and does not come back within a grace period (reload, network blip),
 * the operator dependent is detached.
 *
 * DETACHING IS NOT RELEASING. The operator hold (the claim) is untouched: it
 * still expires by itself (OPERATOR_HOLD_MINUTES) or is released with Release.
 * Closing the tab only stops protecting the BROWSER from the idle collector.
 */
import { browserSessions, operatorDependent } from './BrowserSessions';
import { leaseIdOf, sanitizeProfileId } from './ProfileLease';
import { isValidWorkflowId } from '../utils/redis-keys';

export const VIEWER_GRACE_MS = 30_000;

/**
 * Pure: every (profile, owner) a viewer socket query belongs to.
 * `?profile=<id>` (one) or `?profiles=<id>,<id>` (the ONE shared viewer that
 * shows several profile windows on the same desktop). Invalid ids are dropped.
 */
export function viewersOf(search: string): Array<{ leaseId: string; dependent: string }> {
  let q: URLSearchParams;
  try { q = new URLSearchParams(search || ''); } catch { return []; }
  const raw = [q.get('profile') || '', ...(q.get('profiles') || '').split(',')];
  const wf = q.get('workflowId') || '';
  const owner = isValidWorkflowId(wf) ? wf : 'operator';
  const out: Array<{ leaseId: string; dependent: string }> = [];
  for (const r of raw) {
    const id = sanitizeProfileId(r);
    if (!id) continue;
    const v = { leaseId: leaseIdOf(id), dependent: operatorDependent(owner) };
    if (!out.some((x) => x.leaseId === v.leaseId)) out.push(v);
    if (out.length >= 20) break;
  }
  return out;
}

/** Pure: the first (profile, owner) of a viewer socket query, or null. */
export function viewerOf(search: string): { leaseId: string; dependent: string } | null {
  return viewersOf(search)[0] || null;
}

export class ProfileViewers {
  private readonly open = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly graceMs = VIEWER_GRACE_MS,
    private readonly detach: (leaseId: string, dependent: string) => void = (l, d) => browserSessions().detach(l, d)) {}

  /** A viewer socket connected. Returns the function to call when it closes. */
  connected(search: string): () => void {
    const all = viewersOf(search);
    if (all.length > 1) {
      const closers = all.map((v) => this.connectOne(v));
      return () => { for (const c of closers) c(); };
    }
    const v = all[0];
    if (!v) return () => {};
    return this.connectOne(v);
  }

  private connectOne(v: { leaseId: string; dependent: string }): () => void {
    const k = `${v.leaseId}\u0000${v.dependent}`;
    const t = this.timers.get(k);
    if (t) { clearTimeout(t); this.timers.delete(k); }
    this.open.set(k, (this.open.get(k) || 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.open.get(k) || 1) - 1;
      if (n > 0) { this.open.set(k, n); return; }
      this.open.delete(k);
      const timer = setTimeout(() => {
        this.timers.delete(k);
        if (!this.open.get(k)) this.detach(v.leaseId, v.dependent);
      }, this.graceMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.timers.set(k, timer);
    };
  }

  count(search: string): number {
    const v = viewerOf(search);
    return v ? this.open.get(`${v.leaseId}\u0000${v.dependent}`) || 0 : 0;
  }
}

export const profileViewers = new ProfileViewers();
