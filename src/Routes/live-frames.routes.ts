/**
 * GET /live/frames/:userId/:jobId  ->  text/event-stream of screencast frames.
 *
 * Authentication is `authorizeLive`, i.e. the SAME gate as /live/sse: a signed
 * share token bound to exactly this (userId, jobId), or an API key. A share
 * token is the normal case (it is what the live tab carries), so no API key ever
 * sits in a URL. There is no input route anywhere near this: the stream is
 * server -> client only, which is what makes the live tab view-only.
 *
 * Events:
 *   event: status   data: {"status":"waiting"|"live"|"ended"}
 *   event: frame    data: {"data":"<base64 jpeg>","width":N,"height":N,"ts":N}
 */
import { Router, type Request, type Response } from 'express';
import type { JobScreencastHub, ScreencastFrame, ScreencastStatus } from '../core/JobScreencast';
import { TooManyViewersError } from '../core/JobScreencast';

export type LiveAuthFn = (
  apiKey: string | undefined,
  userId: string,
  opts?: { share?: string | undefined; jobId?: string | undefined },
) => Promise<{ ok: boolean; reason?: string }>;

export interface LiveFramesDeps {
  hub: JobScreencastHub;
  authorize: LiveAuthFn;
  /** Keep-alive comment interval. */
  heartbeatMs?: number;
}

export function createLiveFramesRouter(deps: LiveFramesDeps): Router {
  const router = Router();
  const heartbeatMs = deps.heartbeatMs ?? 25000;

  router.get('/:userId/:jobId', async (req: Request, res: Response) => {
    const userId = String(req.params.userId);
    const jobId = String(req.params.jobId);
    const apiKey = (req.headers['x-api-key'] as string | undefined)
      || (req.query.api_key ? String(req.query.api_key) : undefined);
    const share = req.query.share ? String(req.query.share) : undefined;

    let auth: { ok: boolean; reason?: string };
    try {
      auth = await deps.authorize(apiKey, userId, { share, jobId });
    } catch {
      auth = { ok: false, reason: 'auth_unavailable' };
    }
    if (!auth.ok) {
      res.status(auth.reason === 'missing_api_key' ? 401 : 403).json({
        success: false, error: 'Live access denied', reason: auth.reason,
      });
      return;
    }

    if (!deps.hub.hasRoom(userId, jobId)) {
      res.status(429).json({ success: false, error: 'Too many viewers for this run', reason: 'too_many_viewers' });
      return;
    }

    // Headers go out BEFORE subscribing: subscribe() replays the current status
    // and last frame synchronously, and a write before writeHead would flush
    // default headers (no event-stream content type).
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    let closed = false;
    const send = (event: string, payload: unknown): void => {
      if (closed) return;
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`); } catch { /* gone */ }
    };

    let unsubscribe: () => void;
    try {
      unsubscribe = deps.hub.subscribe(userId, jobId, {
        status: (s: ScreencastStatus) => send('status', { status: s }),
        frame: (f: ScreencastFrame) => {
          // A slow client must not make the server buffer frames without bound:
          // drop until the socket drains. The next frame replaces this one anyway.
          if (res.writableNeedDrain) return;
          send('frame', f);
        },
      });
    } catch (e) {
      // Lost a race for the last seat between hasRoom() and subscribe().
      send('status', { status: e instanceof TooManyViewersError ? 'busy' : 'error' });
      closed = true;
      res.end();
      return;
    }


    const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* gone */ } }, heartbeatMs);
    (hb as any).unref?.();
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(hb);
      unsubscribe();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  });

  return router;
}
