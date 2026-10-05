// ════════════════════════════════════════════════════════════════
// JobArtifacts — files a run produces that the UI must be able to SHOW
// (today: screenshots). Kept next to the job's own result file:
//
//   <PROFILES_DIR>/<userId>/jobs/<jobId>/artifacts/<file>
//
// Why a store instead of base64 in the step output: a full-page PNG is
// megabytes, and step outputs travel over the live channel, per-step webhooks
// and the persisted job file. The item carries a small reference instead; the
// bytes are fetched on demand from GET /job/:userId/:jobId/artifact/:file.
//
// Pure fs + path logic, no Express and no Redis, so it is unit-testable.
// ════════════════════════════════════════════════════════════════

import fs from 'fs/promises';
import path from 'path';
import { config } from '../config';
import { securePath } from '../utils/helpers';

/** Only files we create ourselves can be served: step-<n>.<png|jpg>. */
const ARTIFACT_FILE = /^step-\d{1,6}\.(png|jpg)$/;
const JOB_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

export interface ArtifactRef {
  /** File name inside the job's artifacts dir. */
  file: string;
  mimeType: string;
  size: number;
  /** Relative URL (served behind the normal API-key auth). */
  url: string;
}

export function isValidArtifactFile(file: unknown): file is string {
  return typeof file === 'string' && ARTIFACT_FILE.test(file);
}

export function isValidJobId(jobId: unknown): jobId is string {
  return typeof jobId === 'string' && JOB_ID.test(jobId) && jobId !== '.' && jobId !== '..';
}

export function artifactMime(file: string): string | null {
  const ext = file.split('.').pop() || '';
  return MIME[ext] || null;
}

export function artifactDir(userId: string, jobId: string): string {
  if (!isValidJobId(jobId)) throw new Error('Invalid job id');
  return securePath(config.PROFILES_DIR, userId, 'jobs', jobId, 'artifacts');
}

export function artifactUrl(userId: string, jobId: string, file: string): string {
  return `/job/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/artifact/${encodeURIComponent(file)}`;
}

/** Name for a step's screenshot. `jpeg` is stored as .jpg. */
export function screenshotFileName(stepNumber: number, type: 'png' | 'jpeg'): string {
  return `step-${Math.max(0, Math.floor(stepNumber))}.${type === 'jpeg' ? 'jpg' : 'png'}`;
}

export async function saveArtifact(
  userId: string,
  jobId: string,
  file: string,
  bytes: Buffer
): Promise<ArtifactRef> {
  if (!isValidArtifactFile(file)) throw new Error('Invalid artifact name');
  const dir = artifactDir(userId, jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(securePath(dir, file), bytes);
  return {
    file,
    mimeType: artifactMime(file)!,
    size: bytes.length,
    url: artifactUrl(userId, jobId, file),
  };
}

/**
 * Resolve a requested artifact to a readable file, or null. Two independent
 * guards (a strict name pattern AND containment after resolution), because
 * the cost of being wrong is reading arbitrary files off the server.
 */
export async function resolveArtifact(
  userId: string,
  jobId: string,
  file: string
): Promise<{ path: string; mimeType: string; size: number } | null> {
  if (!isValidJobId(jobId) || !isValidArtifactFile(file)) return null;
  try {
    const dir = artifactDir(userId, jobId);
    const full = securePath(dir, file);
    if (path.dirname(full) !== path.resolve(dir)) return null;
    // lstat, not stat: a symlink is refused outright, so nothing planted in
    // the directory can point the endpoint at a file elsewhere on the server.
    const st = await fs.lstat(full);
    if (!st.isFile()) return null;
    return { path: full, mimeType: artifactMime(file)!, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Delete artifact directories older than ARTIFACT_MAX_AGE_HOURS. Called from
 * the existing garbage collector. Only ever touches
 * <PROFILES_DIR>/<user>/jobs/<job>/artifacts - never the job result files.
 */
export async function sweepArtifacts(now: number = Date.now()): Promise<number> {
  const maxAgeMs = config.ARTIFACT_MAX_AGE_HOURS * 60 * 60 * 1000;
  if (!(maxAgeMs > 0)) return 0; // 0 = keep forever
  let removed = 0;
  let users: string[] = [];
  try { users = await fs.readdir(path.resolve(config.PROFILES_DIR)); } catch { return 0; }
  for (const u of users) {
    const jobsDir = path.join(path.resolve(config.PROFILES_DIR), u, 'jobs');
    let jobs: import('fs').Dirent[] = [];
    try { jobs = await fs.readdir(jobsDir, { withFileTypes: true }); } catch { continue; }
    for (const j of jobs) {
      if (!j.isDirectory()) continue;
      const dir = path.join(jobsDir, j.name, 'artifacts');
      try {
        const st = await fs.stat(dir);
        if (now - st.mtimeMs > maxAgeMs) {
          await fs.rm(dir, { recursive: true, force: true });
          removed++;
        }
      } catch { /* no artifacts dir for this job */ }
    }
  }
  return removed;
}
