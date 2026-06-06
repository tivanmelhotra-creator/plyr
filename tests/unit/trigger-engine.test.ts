import { describe, it, expect } from 'vitest';
import { createHmac } from 'crypto';
import {
  normalizeTrigger,
  isTriggerAction,
  buildItemsFromTrigger,
  buildManualItems,
  validateCron,
  verifyTriggerAuth,
} from '../../src/core/TriggerEngine';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('normalizeTrigger', () => {
  it('defaults to manual + enabled for empty input', () => {
    const t = normalizeTrigger({});
    expect(t.kind).toBe('manual');
    expect(t.enabled).toBe(true);
    expect(t.method).toBe('*');
    expect(t.timezone).toBe('UTC');
  });

  it('derives kind from action id', () => {
    expect(normalizeTrigger({ action: 'trigger_webhook' }).kind).toBe('webhook');
    expect(normalizeTrigger({ action: 'trigger_schedule' }).kind).toBe('schedule');
    expect(normalizeTrigger({ action: 'trigger_telegram' }).kind).toBe('telegram');
    expect(normalizeTrigger({ action: 'trigger_manual' }).kind).toBe('manual');
  });

  it('accepts alias action ids', () => {
    expect(normalizeTrigger({ action: 'cron_trigger' }).kind).toBe('schedule');
    expect(normalizeTrigger({ action: 'webhook_trigger' }).kind).toBe('webhook');
  });

  it('falls back to manual for unknown kinds', () => {
    expect(normalizeTrigger({ action: 'goto' }).kind).toBe('manual');
    expect(normalizeTrigger({ kind: 'nonsense' }).kind).toBe('manual');
  });

  it('uppercases the method and trims cron/timezone', () => {
    const t = normalizeTrigger({ kind: 'webhook', method: 'post', cron: '  */5 * * * *  ', timezone: ' Europe/Berlin ' });
    expect(t.method).toBe('POST');
    expect(t.cron).toBe('*/5 * * * *');
    expect(t.timezone).toBe('Europe/Berlin');
  });

  it('reports hasToken without leaking it', () => {
    expect(normalizeTrigger({ kind: 'telegram', botToken: 'abc:123' }).hasToken).toBe(true);
    expect(normalizeTrigger({ kind: 'telegram' }).hasToken).toBe(false);
  });

  it('respects enabled=false', () => {
    expect(normalizeTrigger({ enabled: false }).enabled).toBe(false);
    expect(normalizeTrigger({ enabled: 'false' }).enabled).toBe(false);
  });
});

describe('isTriggerAction', () => {
  it('recognizes all four trigger action ids', () => {
    expect(isTriggerAction('trigger_manual')).toBe(true);
    expect(isTriggerAction('trigger_webhook')).toBe(true);
    expect(isTriggerAction('trigger_schedule')).toBe(true);
    expect(isTriggerAction('trigger_telegram')).toBe(true);
  });
  it('rejects ordinary actions and non-strings', () => {
    expect(isTriggerAction('click')).toBe(false);
    expect(isTriggerAction(undefined)).toBe(false);
    expect(isTriggerAction(42 as unknown)).toBe(false);
  });
});

describe('buildItemsFromTrigger', () => {
  it('maps an object body to one item, spreading keys + envelope', () => {
    const items = buildItemsFromTrigger({
      body: { foo: 'bar', n: 1 },
      headers: { 'x-test': '1' },
      query: { q: 'z' },
      method: 'post',
    });
    expect(items).toHaveLength(1);
    expect(items[0].json.foo).toBe('bar');
    expect(items[0].json.n).toBe(1);
    expect((items[0].json.body as any).foo).toBe('bar');
    expect((items[0].json.headers as any)['x-test']).toBe('1');
    expect((items[0].json.query as any).q).toBe('z');
    expect(items[0].json.method).toBe('POST');
  });

  it('maps an array body to one item per element', () => {
    const items = buildItemsFromTrigger({ body: [{ a: 1 }, { a: 2 }] });
    expect(items).toHaveLength(2);
    expect(items[0].json.a).toBe(1);
    expect(items[1].json.a).toBe(2);
  });

  it('wraps an empty array body into a single envelope item', () => {
    const items = buildItemsFromTrigger({ body: [] });
    expect(items).toHaveLength(1);
    expect(items[0].json.body).toEqual([]);
  });

  it('emits a single envelope item when body is missing', () => {
    const items = buildItemsFromTrigger({ headers: { h: '1' }, query: { q: '2' }, method: 'GET' });
    expect(items).toHaveLength(1);
    expect((items[0].json.headers as any).h).toBe('1');
    expect(items[0].json.method).toBe('GET');
    expect(items[0].json.body).toBeUndefined();
  });

  it('wraps a primitive body under value', () => {
    const items = buildItemsFromTrigger({ body: 'hello' });
    expect(items[0].json.value).toBe('hello');
  });

  it('wraps a primitive array element under value', () => {
    const items = buildItemsFromTrigger({ body: [5, 6] });
    expect(items[0].json.value).toBe(5);
    expect(items[1].json.value).toBe(6);
  });

  it('tolerates null/undefined input', () => {
    expect(buildItemsFromTrigger(null)).toHaveLength(1);
    expect(buildItemsFromTrigger(undefined)).toHaveLength(1);
  });
});

describe('buildManualItems', () => {
  it('returns a single empty item for null/undefined', () => {
    expect(buildManualItems(undefined)).toEqual([{ json: {} }]);
    expect(buildManualItems(null)).toEqual([{ json: {} }]);
  });
  it('maps an object to a single item', () => {
    expect(buildManualItems({ a: 1 })).toEqual([{ json: { a: 1 } }]);
  });
  it('maps an array to one item per element', () => {
    expect(buildManualItems([{ a: 1 }, { a: 2 }])).toHaveLength(2);
  });
  it('returns empty item for an empty array', () => {
    expect(buildManualItems([])).toEqual([{ json: {} }]);
  });
  it('wraps a primitive under value', () => {
    expect(buildManualItems(7)).toEqual([{ json: { value: 7 } }]);
  });
});

describe('validateCron', () => {
  it('accepts a valid 5-field cron', () => {
    expect(validateCron('*/5 * * * *').valid).toBe(true);
  });
  it('accepts a valid 6-field cron', () => {
    expect(validateCron('0 */5 * * * *').valid).toBe(true);
  });
  it('rejects empty / non-string', () => {
    expect(validateCron('').valid).toBe(false);
    expect(validateCron('   ').valid).toBe(false);
    expect(validateCron(undefined).valid).toBe(false);
    expect(validateCron(42 as unknown).valid).toBe(false);
  });
  it('rejects wrong field counts', () => {
    expect(validateCron('* * *').valid).toBe(false);
    expect(validateCron('* * * * * * *').valid).toBe(false);
  });
  it('tolerates extra whitespace between fields', () => {
    expect(validateCron('*/5   *  *  *  *').valid).toBe(true);
  });
});

describe('verifyTriggerAuth', () => {
  it('passes when no secret and no token configured (open)', () => {
    expect(verifyTriggerAuth({ rawBody: '{}' }, {})).toBe(true);
  });

  it('verifies a correct HMAC signature', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyTriggerAuth({ rawBody: body, signature: sign(body, 's3cr3t') }, { secret: 's3cr3t' })).toBe(true);
  });

  it('rejects a wrong/absent HMAC signature', () => {
    const body = JSON.stringify({ a: 1 });
    expect(verifyTriggerAuth({ rawBody: body, signature: sign(body, 'wrong') }, { secret: 's3cr3t' })).toBe(false);
    expect(verifyTriggerAuth({ rawBody: body }, { secret: 's3cr3t' })).toBe(false);
  });

  it('verifies a matching token', () => {
    expect(verifyTriggerAuth({ providedToken: 'abc123' }, { token: 'abc123' })).toBe(true);
  });

  it('rejects a wrong-length or mismatched token', () => {
    expect(verifyTriggerAuth({ providedToken: 'abc' }, { token: 'abc123' })).toBe(false);
    expect(verifyTriggerAuth({ providedToken: 'xyz456' }, { token: 'abc123' })).toBe(false);
    expect(verifyTriggerAuth({}, { token: 'abc123' })).toBe(false);
  });

  it('requires BOTH when secret and token are configured', () => {
    const body = '{}';
    const okSig = sign(body, 'sek');
    expect(verifyTriggerAuth({ rawBody: body, signature: okSig, providedToken: 'tok123' }, { secret: 'sek', token: 'tok123' })).toBe(true);
    expect(verifyTriggerAuth({ rawBody: body, signature: okSig, providedToken: 'WRONG1' }, { secret: 'sek', token: 'tok123' })).toBe(false);
  });
});
