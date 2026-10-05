/**
 * JobArtifacts — the store behind "show me the screenshot".
 *
 * What this protects:
 *   - a saved image comes back, and ONLY images we wrote ourselves can be read;
 *   - no job id / file name can step outside the job's artifacts directory
 *     (this is the file-read endpoint: the cost of being wrong is reading
 *     arbitrary files off the server);
 *   - users are isolated from each other;
 *   - the sweeper removes old artifacts and nothing else (never the job result).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../src/config';
import {
  saveArtifact, resolveArtifact, sweepArtifacts, screenshotFileName,
  isValidArtifactFile, isValidJobId, artifactUrl,
} from '../../src/core/JobArtifacts';

let tmp = '';
let originalProfiles = '';
let originalAge = 0;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-'));
  originalProfiles = config.PROFILES_DIR;
  originalAge = config.ARTIFACT_MAX_AGE_HOURS;
  (config as { PROFILES_DIR: string }).PROFILES_DIR = tmp;
});

afterEach(async () => {
  (config as { PROFILES_DIR: string }).PROFILES_DIR = originalProfiles;
  (config as { ARTIFACT_MAX_AGE_HOURS: number }).ARTIFACT_MAX_AGE_HOURS = originalAge;
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe('names', () => {
  it('screenshot file names follow the closed pattern', () => {
    expect(screenshotFileName(3, 'png')).toBe('step-3.png');
    expect(screenshotFileName(12, 'jpeg')).toBe('step-12.jpg');
    expect(isValidArtifactFile('step-3.png')).toBe(true);
    expect(isValidArtifactFile('step-3.jpg')).toBe(true);
  });

  it.each([
    '../secret.png', 'step-1.png/../../x', '/etc/passwd', 'step-1.svg', 'step-1.html',
    'step-.png', 'step-1.PNG', 'step-1.png\0', 'a.png', '', 'step-1234567.png',
    '..%2f..%2fetc', 'step-1.png.html',
  ])('rejects the file name %j', (name) => {
    expect(isValidArtifactFile(name)).toBe(false);
  });

  it.each(['', '.', '..', '../x', 'a/b', 'a\\b', 'x'.repeat(200), 'a b'])('rejects the job id %j', (id) => {
    expect(isValidJobId(id)).toBe(false);
  });

  it('builds a url the UI helper accepts, with odd ids encoded', () => {
    expect(artifactUrl('local', '42', 'step-1.png')).toBe('/job/local/42/artifact/step-1.png');
    expect(artifactUrl('u@x', 'repeat:abc:1', 'step-1.png')).toBe('/job/u%40x/repeat%3Aabc%3A1/artifact/step-1.png');
  });
});

describe('save + resolve', () => {
  it('round-trips the bytes', async () => {
    const bytes = Buffer.from('not-really-a-png');
    const ref = await saveArtifact('alice', '7', 'step-2.png', bytes);
    expect(ref).toMatchObject({ file: 'step-2.png', mimeType: 'image/png', size: bytes.length, url: '/job/alice/7/artifact/step-2.png' });

    const found = await resolveArtifact('alice', '7', 'step-2.png');
    expect(found).not.toBeNull();
    expect(found!.mimeType).toBe('image/png');
    expect(found!.size).toBe(bytes.length);
    expect(await fs.readFile(found!.path)).toEqual(bytes);
  });

  it('serves jpeg as image/jpeg', async () => {
    await saveArtifact('alice', '7', 'step-1.jpg', Buffer.from('x'));
    expect((await resolveArtifact('alice', '7', 'step-1.jpg'))!.mimeType).toBe('image/jpeg');
  });

  it('refuses to save a name outside the pattern', async () => {
    await expect(saveArtifact('alice', '7', '../x.png', Buffer.from('x'))).rejects.toThrow(/Invalid artifact name/);
    await expect(saveArtifact('alice', '../7', 'step-1.png', Buffer.from('x'))).rejects.toThrow();
  });

  it('is isolated per user and per job', async () => {
    await saveArtifact('alice', '7', 'step-1.png', Buffer.from('alice'));
    expect(await resolveArtifact('bob', '7', 'step-1.png')).toBeNull();
    expect(await resolveArtifact('alice', '8', 'step-1.png')).toBeNull();
  });

  it('returns null for a missing file, and for a directory named like one', async () => {
    expect(await resolveArtifact('alice', '7', 'step-1.png')).toBeNull();
    await fs.mkdir(path.join(tmp, 'alice', 'jobs', '7', 'artifacts', 'step-9.png'), { recursive: true });
    expect(await resolveArtifact('alice', '7', 'step-9.png')).toBeNull();
  });

  it('cannot be tricked into reading another user\'s file, or the job result file', async () => {
    await saveArtifact('bob', '1', 'step-1.png', Buffer.from('bobs secret'));
    await fs.mkdir(path.join(tmp, 'alice', 'jobs'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'alice', 'jobs', '7.json'), '{"secret":true}');
    for (const [job, file] of [
      ['../../../bob/jobs/1/artifacts', 'step-1.png'],
      ['7', '../../7.json'],
      ['7', '..%2f7.json'],
      ['..', 'step-1.png'],
    ] as const) {
      expect(await resolveArtifact('alice', job, file)).toBeNull();
    }
  });

  it('refuses a symlink that points outside the artifacts dir', async () => {
    const dir = path.join(tmp, 'alice', 'jobs', '7', 'artifacts');
    await fs.mkdir(dir, { recursive: true });
    const outside = path.join(tmp, 'outside.png');
    await fs.writeFile(outside, 'outside');
    await fs.symlink(outside, path.join(dir, 'step-1.png'));
    expect(await resolveArtifact('alice', '7', 'step-1.png')).toBeNull();
  });
});

describe('sweepArtifacts', () => {
  it('removes only artifact dirs older than the limit, never the job result', async () => {
    (config as { ARTIFACT_MAX_AGE_HOURS: number }).ARTIFACT_MAX_AGE_HOURS = 1;
    await saveArtifact('alice', 'old', 'step-1.png', Buffer.from('x'));
    await saveArtifact('alice', 'new', 'step-1.png', Buffer.from('y'));
    const jobs = path.join(tmp, 'alice', 'jobs');
    await fs.writeFile(path.join(jobs, 'old.json'), '{"keep":true}');
    await fs.writeFile(path.join(jobs, 'old_partial.json'), '{}');

    const longAgo = new Date(Date.now() - 3 * 3600 * 1000);
    await fs.utimes(path.join(jobs, 'old', 'artifacts'), longAgo, longAgo);

    const removed = await sweepArtifacts();
    expect(removed).toBe(1);
    expect(await resolveArtifact('alice', 'old', 'step-1.png')).toBeNull();
    expect(await resolveArtifact('alice', 'new', 'step-1.png')).not.toBeNull();
    expect(await fs.readFile(path.join(jobs, 'old.json'), 'utf8')).toBe('{"keep":true}');
  });

  it('keeps everything when the limit is 0 (keep forever)', async () => {
    (config as { ARTIFACT_MAX_AGE_HOURS: number }).ARTIFACT_MAX_AGE_HOURS = 0;
    await saveArtifact('alice', 'old', 'step-1.png', Buffer.from('x'));
    const longAgo = new Date(Date.now() - 999 * 3600 * 1000);
    await fs.utimes(path.join(tmp, 'alice', 'jobs', 'old', 'artifacts'), longAgo, longAgo);
    expect(await sweepArtifacts()).toBe(0);
    expect(await resolveArtifact('alice', 'old', 'step-1.png')).not.toBeNull();
  });

  it('does not throw when there is nothing to sweep', async () => {
    expect(await sweepArtifacts()).toBe(0);
  });
});
