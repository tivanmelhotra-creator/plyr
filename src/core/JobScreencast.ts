/**
 * JobScreencast — a VIEW-ONLY picture of the page a job is driving.
 *
 * WHY A SCREENCAST AND NOT THE /desktop VNC VIEW
 * ----------------------------------------------
 * The shareable live tab is authenticated by a signed SHARE TOKEN, never by an
 * API key (a key in a URL ends up in history and proxy logs). The VNC desktop
 * is a full remote control: its credential grants keyboard and mouse, and
 * noVNC's `viewOnly` flag is enforced by the CLIENT only, so handing that
 * credential to a share link would hand out control no matter what the page
 * says. A CDP screencast has no input path at all, so "view-only" is a property
 * of the server, not of a checkbox.
 *
 * It also needs no X display, so it works for a headless run too.
 *
 * SHAPE
 * -----
 * One hub per process. For each (user, job) that has at least one viewer the
 * hub attaches ONE CDP session to the job's current page and fans the frames
 * out. When the last viewer leaves the session is detached, so an unwatched run
 * pays nothing. The job's page can change (new tab, popup, a relaunch), so a
 * light poll re-attaches to whatever `getPage(jobId)` says now.
 *
 * Everything the hub touches is injected (`getPage`, the clock, the timers), so
 * the whole thing is unit-tested with a fake CDP session; a separate test drives
 * real Chromium.
 */

export interface ScreencastFrame {
  /** base64 JPEG, no data: prefix. */
  data: string;
  width: number;
  height: number;
  /** ms since epoch, taken on the server. */
  ts: number;
}

export type ScreencastStatus = 'waiting' | 'live' | 'ended';

export interface ScreencastListener {
  frame(f: ScreencastFrame): void;
  status(s: ScreencastStatus): void;
}

/** The slice of Playwright's CDPSession the hub uses. */
export interface CdpLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, fn: (p: any) => void): unknown;
  detach(): Promise<void>;
}

/** The slice of Playwright's Page the hub uses. */
export interface PageLike {
  isClosed(): boolean;
  context(): { newCDPSession(page: any): Promise<CdpLike> };
}

export interface HubOptions {
  getPage: (jobId: string) => PageLike | undefined;
  /** How often to look for a changed / closed page. */
  pollMs?: number;
  /** Frames closer together than this are dropped (they are still acked). */
  minIntervalMs?: number;
  /** Hard cap on viewers of ONE job. */
  maxViewersPerJob?: number;
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  now?: () => number;
}

export const DEFAULT_POLL_MS = 1000;
export const DEFAULT_MIN_INTERVAL_MS = 120;
export const DEFAULT_MAX_VIEWERS = 5;

export class TooManyViewersError extends Error {
  constructor() {
    super('too_many_viewers');
    this.name = 'TooManyViewersError';
  }
}

interface JobState {
  key: string;
  jobId: string;
  listeners: Set<ScreencastListener>;
  page: PageLike | null;
  cdp: CdpLike | null;
  attaching: boolean;
  status: ScreencastStatus;
  everLive: boolean;
  lastFrame: ScreencastFrame | null;
  lastEmit: number;
  timer: ReturnType<typeof setInterval> | null;
}

export class JobScreencastHub {
  private readonly jobs = new Map<string, JobState>();
  private readonly pollMs: number;
  private readonly minIntervalMs: number;
  private readonly maxViewers: number;
  private readonly quality: number;
  private readonly maxWidth: number;
  private readonly maxHeight: number;
  private readonly now: () => number;

  constructor(private readonly opts: HubOptions) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.minIntervalMs = opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxViewers = opts.maxViewersPerJob ?? DEFAULT_MAX_VIEWERS;
    this.quality = opts.quality ?? 55;
    this.maxWidth = opts.maxWidth ?? 1280;
    this.maxHeight = opts.maxHeight ?? 800;
    this.now = opts.now ?? Date.now;
  }

  /** Number of jobs with at least one viewer (for tests / diagnostics). */
  activeJobs(): number { return this.jobs.size; }
  viewers(userId: string, jobId: string): number {
    return this.jobs.get(this.keyOf(userId, jobId))?.listeners.size ?? 0;
  }
  /** Would a new viewer of this job be accepted right now? */
  hasRoom(userId: string, jobId: string): boolean {
    return this.viewers(userId, jobId) < this.maxViewers;
  }

  private keyOf(userId: string, jobId: string): string { return `${userId}\u0000${jobId}`; }

  /**
   * Start watching a job. Returns the function that stops watching.
   * Throws TooManyViewersError past the per-job cap.
   */
  subscribe(userId: string, jobId: string, listener: ScreencastListener): () => void {
    const key = this.keyOf(userId, jobId);
    let job = this.jobs.get(key);
    if (!job) {
      job = {
        key, jobId, listeners: new Set(), page: null, cdp: null, attaching: false,
        status: 'waiting', everLive: false, lastFrame: null, lastEmit: 0, timer: null,
      };
      this.jobs.set(key, job);
    }
    if (job.listeners.size >= this.maxViewers) {
      if (job.listeners.size === 0) this.jobs.delete(key);
      throw new TooManyViewersError();
    }
    job.listeners.add(listener);

    // A late joiner (or a reconnect) sees the current state immediately instead
    // of an empty pane until the page happens to repaint.
    safe(() => listener.status(job!.status));
    if (job.lastFrame) safe(() => listener.frame(job!.lastFrame!));

    if (!job.timer) {
      job.timer = setInterval(() => { void this.tick(job!); }, this.pollMs);
      (job.timer as any).unref?.();
      void this.tick(job);
    }

    let done = false;
    return () => {
      if (done) return;
      done = true;
      job!.listeners.delete(listener);
      if (job!.listeners.size === 0) void this.dispose(job!);
    };
  }

  /** Stop everything (process shutdown / tests). */
  async shutdown(): Promise<void> {
    for (const job of [...this.jobs.values()]) { job.listeners.clear(); await this.dispose(job); }
  }

  // ---- internals ----------------------------------------------------------

  private async dispose(job: JobState): Promise<void> {
    if (job.timer) { clearInterval(job.timer); job.timer = null; }
    this.jobs.delete(job.key);
    await this.detach(job);
  }

  private async detach(job: JobState): Promise<void> {
    const cdp = job.cdp;
    job.cdp = null;
    job.page = null;
    if (!cdp) return;
    try { await cdp.send('Page.stopScreencast'); } catch { /* page already gone */ }
    try { await cdp.detach(); } catch { /* already detached */ }
  }

  private setStatus(job: JobState, s: ScreencastStatus): void {
    if (job.status === s) return;
    job.status = s;
    if (s === 'live') job.everLive = true;
    for (const l of [...job.listeners]) safe(() => l.status(s));
  }

  private async tick(job: JobState): Promise<void> {
    if (job.attaching || !this.jobs.has(job.key)) return;
    let page: PageLike | undefined;
    try { page = this.opts.getPage(job.jobId); } catch { page = undefined; }
    if (page && page.isClosed()) page = undefined;

    if (!page) {
      if (job.cdp) await this.detach(job);
      this.setStatus(job, job.everLive ? 'ended' : 'waiting');
      return;
    }
    if (page === job.page && job.cdp) return; // already attached to this one
    await this.attach(job, page);
  }

  private async attach(job: JobState, page: PageLike): Promise<void> {
    job.attaching = true;
    try {
      if (job.cdp) await this.detach(job);
      const cdp = await page.context().newCDPSession(page);
      cdp.on('Page.screencastFrame', (p: any) => {
        // Ack FIRST and always: Chromium stops sending after a few unacked
        // frames, and a throttled frame must not stall the stream.
        cdp.send('Page.screencastFrameAck', { sessionId: p?.sessionId }).catch(() => {});
        if (job.cdp !== cdp || typeof p?.data !== 'string') return;
        const t = this.now();
        if (t - job.lastEmit < this.minIntervalMs) return;
        job.lastEmit = t;
        const md = p.metadata || {};
        const frame: ScreencastFrame = {
          data: p.data,
          width: Number(md.deviceWidth) || 0,
          height: Number(md.deviceHeight) || 0,
          ts: t,
        };
        job.lastFrame = frame;
        for (const l of [...job.listeners]) safe(() => l.frame(frame));
      });
      cdp.on('Detached', () => { if (job.cdp === cdp) { job.cdp = null; job.page = null; } });
      job.cdp = cdp;
      job.page = page;
      await cdp.send('Page.startScreencast', {
        format: 'jpeg', quality: this.quality,
        maxWidth: this.maxWidth, maxHeight: this.maxHeight, everyNthFrame: 1,
      });
      this.setStatus(job, 'live');
    } catch {
      // The page died between the poll and the attach. Next tick decides.
      job.cdp = null;
      job.page = null;
    } finally {
      job.attaching = false;
    }
  }
}

function safe(fn: () => void): void {
  try { fn(); } catch { /* one bad listener must not break the others */ }
}
