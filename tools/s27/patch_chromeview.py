p='src/core/ChromeView.ts'; s=open(p).read()
if 'VIEW_SET_KEY' in s:
    print('already'); raise SystemExit
old="""const wsViewQuery = qs.get('profile')
  ? '?profile=' + encodeURIComponent(qs.get('profile')) + (qs.get('workflowId') ? '&workflowId=' + encodeURIComponent(qs.get('workflowId')) : '')
  : '';"""
assert old in s
new="""// ONE SHARED VIEWER. The desktop is one display holding every browser window
// (Local Browser and each profile), so one tab shows them all. This tab keeps
// the set of profiles it was asked to show (sessionStorage = this tab only;
// survives the reload a second Open causes), and its VNC socket carries the
// whole set: while the tab is connected the operator counts as watching EVERY
// one of them; closing the tab detaches all of them after the grace period.
const VIEW_SET_KEY = 'aria.viewer.profiles';
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
function viewSet() {
  let list = [];
  try { list = JSON.parse(sessionStorage.getItem(VIEW_SET_KEY) || '[]'); } catch (e) { list = []; }
  if (!Array.isArray(list)) list = [];
  const add = qs.get('profile');
  if (add && PROFILE_ID_RE.test(add) && list.indexOf(add) < 0) list.push(add);
  list = list.filter((x) => typeof x === 'string' && PROFILE_ID_RE.test(x)).slice(-20);
  try { sessionStorage.setItem(VIEW_SET_KEY, JSON.stringify(list)); } catch (e) { /* private mode */ }
  return list;
}
const viewProfiles = viewSet();
const wsViewQuery = viewProfiles.length
  ? '?profiles=' + encodeURIComponent(viewProfiles.join(',')) + (qs.get('workflowId') ? '&workflowId=' + encodeURIComponent(qs.get('workflowId')) : '')
  : '';"""
s=s.replace(old,new,1)
old2="""  const viewProfile = qs.get('profile');
  if (viewProfile) {"""
assert old2 in s
s=s.replace(old2,"""  const viewProfile = qs.get('profile');
  // ATTACH (Show browser / a profile view): put the shared desktop back on
  // screen WITHOUT starting or restarting any browser; only the display and
  // VNC stack are ensured. Turn on is the only path that starts the Local
  // Browser from this page.
  const attachOnly = qs.get('attach') === '1' || viewProfiles.length > 0;
  if (viewProfile || attachOnly) {""",1)
old3="""      const visible = j.sessions.filter((x) => x && x.visibility !== 'hidden');"""
assert old3 in s
s=s.replace(old3,"""      const visible = j.sessions.filter((x) => x && x.visibility !== 'hidden');
      // Profiles whose browser is gone leave this tab's set.
      try {
        const open = j.sessions.map((x) => x && x.profileId).filter(Boolean);
        sessionStorage.setItem(VIEW_SET_KEY, JSON.stringify(viewProfiles.filter((id) => open.indexOf(id) >= 0)));
      } catch (e) { /* fine */ }""",1)
open(p,'w').write(s); print('patched')
