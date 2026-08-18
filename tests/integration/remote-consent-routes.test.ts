import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { remoteConsent } from '../../src/core/RemoteConsent';

describe('Remote Consent Routes', () => {
  let app: Express;

  beforeAll(async () => {
    const { createModeRoutes } = await import('../../src/Routes/mode.routes');
    app = express();
    app.use(express.json());

    // Mock authentication middleware
    app.use((req: any, _res, next) => {
      req.user = { id: 'test_user_1', apiKey: 'test_key_abc' };
      req.apiKey = 'test_key_abc';
      req.apiKeyUserId = 'test_user_1';
      next();
    });

    app.use(createModeRoutes());
  });

  beforeEach(() => {
    remoteConsent.clear();
  });

  it('returns pending consent when active', async () => {
    remoteConsent.open('test_user_1', {
      targetFieldId: 'tf_test_1',
      nodeId: 'node_1',
      fieldKey: 'cssSelector',
      nodeName: 'Button Click'
    });

    const res = await request(app)
      .get('/inspector/consent/pending')
      .set('x-api-key', 'test_key_abc')
      .set('X-Forwarded-For', '127.0.0.1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.offer).toBeDefined();
    expect(res.body.offer.target.targetFieldId).toBe('tf_test_1');
  });

  it('accepts pending consent from same host peer', async () => {
    const offer = remoteConsent.open('test_user_1', {
      targetFieldId: 'tf_test_1',
      nodeId: 'node_1',
      fieldKey: 'cssSelector'
    });

    const res = await request(app)
      .post('/inspector/consent/accept')
      .set('x-api-key', 'test_key_abc')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ offerId: offer.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.target.targetFieldId).toBe('tf_test_1');
  });

  it('rejects pending consent', async () => {
    const offer = remoteConsent.open('test_user_1', {
      targetFieldId: 'tf_test_1',
      nodeId: 'node_1',
      fieldKey: 'cssSelector'
    });

    const res = await request(app)
      .post('/inspector/consent/reject')
      .set('x-api-key', 'test_key_abc')
      .set('X-Forwarded-For', '127.0.0.1')
      .send({ offerId: offer.id });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
