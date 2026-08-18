import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  signWebhookBody,
  verifyWebhookSignature,
  SIGNATURE_PREFIX,
} from '../../src/utils/signature';

// Reference HMAC computed independently of the implementation, so the test
// pins the exact wire format an external receiver would verify against.
const refHmac = (body: string, secret: string): string =>
  createHmac('sha256', secret).update(body, 'utf8').digest('hex');

describe('signWebhookBody', () => {
  const secret = 'top-secret';
  const body = JSON.stringify({ event: 'job.completed', jobId: '42' });

  it('prefixes the digest with "sha256="', () => {
    const sig = signWebhookBody(body, secret);
    expect(sig.startsWith(SIGNATURE_PREFIX)).toBe(true);
    expect(sig).toBe(`${SIGNATURE_PREFIX}${refHmac(body, secret)}`);
  });

  it('produces a 64-char hex digest', () => {
    const sig = signWebhookBody(body, secret).slice(SIGNATURE_PREFIX.length);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same body + secret', () => {
    expect(signWebhookBody(body, secret)).toBe(signWebhookBody(body, secret));
  });

  it('changes when the body changes', () => {
    const a = signWebhookBody(body, secret);
    const b = signWebhookBody(body + ' ', secret);
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    expect(signWebhookBody(body, 'a')).not.toBe(signWebhookBody(body, 'b'));
  });
});

describe('verifyWebhookSignature', () => {
  const secret = 'shared-key-123';
  const body = JSON.stringify({ ok: true, n: 7 });

  it('verifies a signature produced by signWebhookBody', () => {
    const sig = signWebhookBody(body, secret);
    expect(verifyWebhookSignature(body, secret, sig)).toBe(true);
  });

  it('accepts the digest with or without the sha256= prefix', () => {
    const hex = refHmac(body, secret);
    expect(verifyWebhookSignature(body, secret, hex)).toBe(true);
    expect(verifyWebhookSignature(body, secret, `${SIGNATURE_PREFIX}${hex}`)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const sig = signWebhookBody(body, secret);
    expect(verifyWebhookSignature(body + 'x', secret, sig)).toBe(false);
  });

  it('rejects a wrong secret', () => {
    const sig = signWebhookBody(body, secret);
    expect(verifyWebhookSignature(body, 'other', sig)).toBe(false);
  });

  it('rejects missing / empty / malformed signatures without throwing', () => {
    expect(verifyWebhookSignature(body, secret, undefined)).toBe(false);
    expect(verifyWebhookSignature(body, secret, null)).toBe(false);
    expect(verifyWebhookSignature(body, secret, '')).toBe(false);
    expect(verifyWebhookSignature(body, secret, 'sha256=zz')).toBe(false);
    expect(verifyWebhookSignature(body, secret, 'not-hex-and-wrong-length')).toBe(false);
  });
});
