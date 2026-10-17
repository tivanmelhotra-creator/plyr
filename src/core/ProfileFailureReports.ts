/**
 * ProfileFailureReports — why a workflow could not use its browser profile.
 *
 * Written when activation / schedule saving is refused because a referenced
 * profile is missing or broken, and when a run detects (before launching)
 * that its profile folder was removed outside Aria. Read by the UI
 * (GET /profiles/reports) so the user is told, not only the log.
 *
 * Reasons: `profile_missing` (record gone: the profile was never there or its
 * branch was deleted) and `profile_broken` (record exists but its branch or
 * folder is missing on disk). The detail is one of record_missing /
 * branch_missing / folder_missing. No paths are stored (only names and ids).
 *
 * Redis list per user, newest first, bounded (MAX). Best-effort: a failed
 * write never blocks the refusal itself.
 */
import type IORedis from 'ioredis';

export type FailureReason = 'profile_missing' | 'profile_broken' | 'profile_locked';
export type FailureDetail = 'record_missing' | 'branch_missing' | 'folder_missing' | 'locked_to_other';

export interface FailureReport {
  at: string;
  reason: FailureReason;
  detail: FailureDetail;
  /** activation | schedule | run */
  stage: 'activation' | 'schedule' | 'run';
  workflowId?: string | null;
  workflowName?: string | null;
  profileId: string;
  profileName?: string | null;
  jobId?: string | null;
  message: string;
}

const KEY = (userId: string) => `profile:failures:${userId}`;
const MAX = 200;

export function reasonOf(detail: FailureDetail): FailureReason {
  return detail === 'record_missing' ? 'profile_missing' : 'profile_broken';
}

export class ProfileFailureReports {
  constructor(private readonly redis: IORedis | null) {}

  async record(userId: string, r: Omit<FailureReport, 'at'>): Promise<FailureReport> {
    const full: FailureReport = { at: new Date().toISOString(), ...r };
    if (this.redis) {
      try {
        await this.redis.lpush(KEY(userId), JSON.stringify(full));
        await this.redis.ltrim(KEY(userId), 0, MAX - 1);
      } catch { /* best-effort */ }
    }
    console.warn(`[PROFILES] ${full.reason} (${full.detail}) at ${full.stage}: ${full.message}`);
    return full;
  }

  async list(userId: string, limit = 50): Promise<FailureReport[]> {
    if (!this.redis) return [];
    try {
      const raw = await this.redis.lrange(KEY(userId), 0, Math.max(0, Math.min(MAX, limit) - 1));
      return raw.map((x) => { try { return JSON.parse(x) as FailureReport; } catch { return null; } }).filter((x): x is FailureReport => !!x);
    } catch { return []; }
  }
}

let active: ProfileFailureReports = new ProfileFailureReports(null);
export function registerProfileFailureReports(r: ProfileFailureReports): void { active = r; }
export function profileFailureReports(): ProfileFailureReports { return active; }
