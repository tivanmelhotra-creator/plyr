p='src/core/ProfileViewers.ts'; s=open(p).read()
if 'viewersOf' in s: print('already'); raise SystemExit
old="""/** Pure: which (profile, owner) a viewer socket query belongs to, or null. */
export function viewerOf(search: string): { leaseId: string; dependent: string } | null {
  let q: URLSearchParams;
  try { q = new URLSearchParams(search || ''); } catch { return null; }
  const id = sanitizeProfileId(q.get('profile'));
  if (!id) return null;
  const wf = q.get('workflowId') || '';
  const owner = isValidWorkflowId(wf) ? wf : 'operator';
  return { leaseId: leaseIdOf(id), dependent: operatorDependent(owner) };
}"""
assert old in s
new="""/**
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
}"""
s=s.replace(old,new,1)
old2="""  /** A viewer socket connected. Returns the function to call when it closes. */
  connected(search: string): () => void {
    const v = viewerOf(search);
    if (!v) return () => {};"""
assert old2 in s
s=s.replace(old2,"""  /** A viewer socket connected. Returns the function to call when it closes. */
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

  private connectOne(v: { leaseId: string; dependent: string }): () => void {""",1)
s=s.replace("""    const v = viewerOf(search);
    return v ? this.open.get(""","""    const v = viewerOf(search);
    return v ? this.open.get(""")
open(p,'w').write(s); print('patched')
