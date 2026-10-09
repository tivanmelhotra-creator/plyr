/**
 * Execution history (SQLite only). One row per finished job: which workflow,
 * how it was triggered, final status, timings, the error, and per-step
 * summaries (action, success, duration, error, item counts and a SMALL sample
 * of output items — never full payloads, so the table stays bounded).
 *
 * Retention: `prune()` deletes rows older than EXECUTION_RETENTION_DAYS and
 * keeps at most EXECUTION_MAX_ROWS (whichever bites first). It runs at boot
 * and after every 50 inserts, so no scheduler is needed.
 */
import type { SqliteDb } from '../core/SqliteStore';

export type ExecutionStatus = 'success' | 'error' | 'cancelled';

export interface ExecutionStepRecord {
  step: number;
  action: string;
  success: boolean;
  durationMs?: number;
  error?: string;
  inputItemCount?: number;
  outputItemCount?: number;
  outputSample?: unknown[];
}

export interface ExecutionRecord {
  jobId: string;
  userId: string;
  workflowId?: string | null;
  workflowVersion?: number | null;
  trigger?: string | null;
  status: ExecutionStatus;
  startedAt?: string | null;
  finishedAt: string;
  durationMs?: number | null;
  error?: string | null;
  steps: ExecutionStepRecord[];
}

export const MAX_SAMPLE_ITEMS_PER_STEP = 3;
const MAX_SAMPLE_CHARS = 4000;
const MAX_STEPS_PER_EXECUTION = 1000;

/** Reduce raw StepOutput-like objects to what history keeps. */
export function summarizeSteps(raw: unknown[]): ExecutionStepRecord[] {
  const out: ExecutionStepRecord[] = [];
  for (const s of (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS_PER_EXECUTION)) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    const rec: ExecutionStepRecord = {
      step: Number(o.step) || out.length + 1,
      action: String(o.action || ''),
      success: o.success !== false,
    };
    if (typeof o.durationMs === 'number') rec.durationMs = o.durationMs;
    if (o.error) rec.error = String(o.error).slice(0, 2000);
    if (typeof o.inputItemCount === 'number') rec.inputItemCount = o.inputItemCount;
    if (typeof o.outputItemCount === 'number') rec.outputItemCount = o.outputItemCount;
    if (Array.isArray(o.outputSample)) {
      const sample = o.outputSample.slice(0, MAX_SAMPLE_ITEMS_PER_STEP);
      let text = '';
      try { text = JSON.stringify(sample); } catch { text = ''; }
      rec.outputSample = text && text.length <= MAX_SAMPLE_CHARS ? sample : [{ truncated: true }];
    }
    out.push(rec);
  }
  return out;
}

interface Row {
  job_id: string; user_id: string; workflow_id: string | null; workflow_version: number | null;
  trigger: string | null; status: string; started_at: string | null; finished_at: string;
  duration_ms: number | null; error: string | null; steps: string;
}

function fromRow(r: Row, withSteps: boolean): ExecutionRecord {
  let steps: ExecutionStepRecord[] = [];
  if (withSteps) { try { steps = JSON.parse(r.steps); } catch { steps = []; } }
  return {
    jobId: r.job_id, userId: r.user_id, workflowId: r.workflow_id, workflowVersion: r.workflow_version,
    trigger: r.trigger, status: r.status as ExecutionStatus, startedAt: r.started_at,
    finishedAt: r.finished_at, durationMs: r.duration_ms, error: r.error, steps,
  };
}

export class ExecutionRepository {
  private inserts = 0;
  constructor(
    private readonly db: SqliteDb,
    private readonly retention: { days: number; maxRows: number } = { days: 30, maxRows: 10000 },
  ) {}

  record(rec: ExecutionRecord): void {
    this.db.prepare(`
      INSERT INTO executions (job_id, user_id, workflow_id, workflow_version, trigger, status,
        started_at, finished_at, duration_ms, error, steps)
      VALUES (@jobId, @userId, @workflowId, @workflowVersion, @trigger, @status,
        @startedAt, @finishedAt, @durationMs, @error, @steps)
      ON CONFLICT(job_id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
        duration_ms = excluded.duration_ms, error = excluded.error, steps = excluded.steps
    `).run({
      jobId: rec.jobId,
      userId: rec.userId,
      workflowId: rec.workflowId ?? null,
      workflowVersion: rec.workflowVersion ?? null,
      trigger: rec.trigger ?? null,
      status: rec.status,
      startedAt: rec.startedAt ?? null,
      finishedAt: rec.finishedAt,
      durationMs: rec.durationMs ?? null,
      error: rec.error ? String(rec.error).slice(0, 4000) : null,
      steps: JSON.stringify(summarizeSteps(rec.steps)),
    });
    if (++this.inserts % 50 === 0) this.prune();
  }

  get(userId: string, jobId: string): ExecutionRecord | null {
    const r = this.db.prepare('SELECT * FROM executions WHERE user_id = ? AND job_id = ?').get(userId, jobId) as Row | undefined;
    return r ? fromRow(r, true) : null;
  }

  /** Newest first; steps are omitted from list rows (fetch one to get them). */
  list(userId: string, opts: { workflowId?: string | null; limit?: number; before?: string | null } = {}): ExecutionRecord[] {
    const limit = Math.min(Math.max(opts.limit || 50, 1), 500);
    const where = ['user_id = @userId'];
    if (opts.workflowId) where.push('workflow_id = @workflowId');
    if (opts.before) where.push('finished_at < @before');
    const rows = this.db.prepare(
      `SELECT * FROM executions WHERE ${where.join(' AND ')} ORDER BY finished_at DESC LIMIT @limit`
    ).all({ userId, workflowId: opts.workflowId ?? null, before: opts.before ?? null, limit }) as Row[];
    return rows.map((r) => fromRow(r, false));
  }

  /** Delete by age, then by row cap. Returns rows removed. */
  prune(now: Date = new Date()): number {
    let removed = 0;
    if (this.retention.days > 0) {
      const cutoff = new Date(now.getTime() - this.retention.days * 86400000).toISOString();
      removed += this.db.prepare('DELETE FROM executions WHERE finished_at < ?').run(cutoff).changes;
    }
    if (this.retention.maxRows > 0) {
      removed += this.db.prepare(`
        DELETE FROM executions WHERE job_id IN (
          SELECT job_id FROM executions ORDER BY finished_at DESC LIMIT -1 OFFSET ?
        )`).run(this.retention.maxRows).changes;
    }
    return removed;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM executions').get() as { n: number }).n;
  }
}
