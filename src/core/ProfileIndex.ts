/**
 * ProfileIndex — synchronous map profile id -> its branch (lock key, root,
 * folder), filled by core/BranchRegistry whenever it loads or saves.
 *
 * Separate module so core/ProfileLease (lock names) can read it without an
 * import cycle. Absent entry = a profile the registry has not seen: callers
 * fall back to the legacy rule (one root per profile).
 */
export interface IndexEntry { userId: string; profileId: string; branchId: string; leaseKey: string; root: string; folder: string; name: string }

const byProfile = new Map<string, IndexEntry>();

export function indexedProfile(profileId: string): IndexEntry | null { return byProfile.get(profileId) || null; }
export function indexedByLeaseKey(leaseKey: string): IndexEntry[] { return [...byProfile.values()].filter((e) => e.leaseKey === leaseKey); }
export function replaceIndexFor(userId: string, entries: IndexEntry[]): void {
  for (const [k, v] of byProfile) if (v.userId === userId) byProfile.delete(k);
  for (const e of entries) byProfile.set(e.profileId, e);
}
export function clearProfileIndex(): void { byProfile.clear(); }
