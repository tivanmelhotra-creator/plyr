import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

import { RealChrome, RealChromeError } from '../../src/core/RealChrome';

let app: Express;

describe('browser routes: /browser/real/chooser with runtime/page-scoped identities', () => {
  beforeAll(async () => {
    const { createBrowserRoutes } = await import('../../src/Routes/browser.routes');

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as { apiKeyUserId?: string }).apiKeyUserId = 'local';
      next();
    });
    app.use(createBrowserRoutes());
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /browser/real/chooser queries any pending chooser when pageId is omitted', async () => {
    vi.spyOn(RealChrome, 'downloadOwner').mockReturnValue('real_chrome_user');
    vi.spyOn(RealChrome, 'pendingChooser').mockImplementation((pageId?: string) => {
      expect(pageId).toBeUndefined();
      return {
        id: 'r1:p1:fc1',
        multiple: false,
        accept: '',
        name: '',
        at: 123456,
      } as any;
    });

    const res = await request(app).get('/browser/real/chooser');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      owner: 'real_chrome_user',
      chooser: {
        id: 'r1:p1:fc1',
        multiple: false,
        accept: '',
        name: '',
        at: 123456,
      },
    });
  });

  it('GET /browser/real/chooser queries page-specific chooser when pageId is provided', async () => {
    vi.spyOn(RealChrome, 'downloadOwner').mockReturnValue('real_chrome_user');
    vi.spyOn(RealChrome, 'pendingChooser').mockImplementation((pageId?: string) => {
      if (pageId === 'r1:p2') {
        return {
          id: 'r1:p2:fc2',
          multiple: true,
          accept: '.png',
          name: 'avatar',
          at: 999999,
        } as any;
      }
      return null;
    });

    const res = await request(app).get('/browser/real/chooser?pageId=r1:p2');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      owner: 'real_chrome_user',
      chooser: {
        id: 'r1:p2:fc2',
        multiple: true,
        accept: '.png',
        name: 'avatar',
        at: 999999,
      },
    });
  });

  it('POST /browser/real/chooser routes tokens and pageId to RealChrome.acceptChooserFiles', async () => {
    const acceptSpy = vi.spyOn(RealChrome, 'acceptChooserFiles').mockResolvedValue({
      count: 2,
      persisted: ['/tmp/upload1.txt', '/tmp/upload2.txt'],
    });

    const res = await request(app)
      .post('/browser/real/chooser')
      .send({
        id: 'r1:p2:fc2',
        tokens: ['tok1', 'tok2'],
        pageId: 'r1:p2',
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      count: 2,
      persisted: ['/tmp/upload1.txt', '/tmp/upload2.txt'],
    });
    expect(acceptSpy).toHaveBeenCalledWith('r1:p2:fc2', ['tok1', 'tok2'], 'r1:p2');
  });

  it('POST /browser/real/chooser validates required fields', async () => {
    const resNoId = await request(app)
      .post('/browser/real/chooser')
      .send({ tokens: ['tok1'] });
    expect(resNoId.status).toBe(400);

    const resNoTokens = await request(app)
      .post('/browser/real/chooser')
      .send({ id: 'fc1', tokens: [] });
    expect(resNoTokens.status).toBe(400);
  });

  it('DELETE /browser/real/chooser cancels chooser with pageId from query or body', async () => {
    const cancelSpy = vi.spyOn(RealChrome, 'cancelChooser').mockResolvedValue(true);

    const resQuery = await request(app).delete('/browser/real/chooser?id=fc1&pageId=r1:p1');
    expect(resQuery.status).toBe(200);
    expect(resQuery.body).toEqual({ success: true, cancelled: true });
    expect(cancelSpy).toHaveBeenCalledWith('fc1', 'r1:p1');

    const resBody = await request(app)
      .delete('/browser/real/chooser')
      .send({ id: 'fc2', pageId: 'r1:p2' });
    expect(resBody.status).toBe(200);
    expect(resBody.body).toEqual({ success: true, cancelled: true });
    expect(cancelSpy).toHaveBeenCalledWith('fc2', 'r1:p2');
  });
});
