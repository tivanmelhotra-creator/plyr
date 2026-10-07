import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseExchange, buildNativeEnvelope, exchangeLoadError } from '../../src/core/WorkflowExchange';

const JS = path.join(__dirname, '..', '..', 'public', 'js');

/** Load the browser module exactly as the page does (actions + options + exchange). */
function clientApi(): any {
  const win: any = {};
  for (const f of ['actions.js', 'browser-options.js', 'workflow-exchange.js']) {
    new Function('window', fs.readFileSync(path.join(JS, f), 'utf8')).call(win, win);
  }
  return win.WorkflowExchange;
}

const steps = [
  { action: 'goto', params: { url: 'https://example.com' } },
  { action: 'code', params: { code: 'return 1' } },
  { action: 'if', condition: { left: 'a', op: 'eq', right: 'b' }, then: [{ action: 'code', params: { code: 'return 2' } }], else: [] },
];

describe('workflow-exchange (shared module)', () => {
  const X = clientApi();

  it('loads server-side without error', () => {
    expect(exchangeLoadError()).toBe('');
  });

  it('builds the native envelope', () => {
    const env = X.buildEnvelope({ name: 'N', description: 'd', steps, headless: true }, { now: new Date('2026-01-01T00:00:00Z') });
    expect(env.format).toBe('plyr-workflow');
    expect(env.version).toBe(1);
    expect(env.exportedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(env.workflow.name).toBe('N');
    expect(env.workflow.headless).toBe(true);
    expect(env.workflow.steps).toEqual(steps);
  });

  it('blanks password fields and secret browser options, and lists them', () => {
    const pw = X.ACTION_CATALOG; // not exposed on X; use the catalog through a fresh window
    void pw;
    const win: any = {};
    new Function('window', fs.readFileSync(path.join(JS, 'actions.js'), 'utf8')).call(win, win);
    const secret = win.ACTION_CATALOG.ACTIONS.flatMap((a: any) => (a.fields || []).filter((f: any) => f.type === 'password').map((f: any) => [a.id, f.k]));
    expect(secret.length).toBeGreaterThan(0);
    const [action, key] = secret[0];
    const r = X.redact([{ action, params: { [key]: 'TOPSECRET', other: 'keep' } }]);
    expect(JSON.stringify(r.steps)).not.toContain('TOPSECRET');
    expect(r.steps[0].params.other).toBe('keep');
    expect(r.redacted).toContain(`${action}.${key}`);
  });

  it('redacts secret launch options inside nested steps', () => {
    const r = X.redact([{ action: 'if', then: [{ action: 'launchBrowser', params: { browserOptions: { proxyPassword: 'pw', locale: 'fa-IR' } } }] }]);
    const txt = JSON.stringify(r.steps);
    expect(txt).not.toContain('"pw"');
    expect(r.redacted.some((x: string) => x.startsWith('launchBrowser.browserOptions.'))).toBe(r.redacted.length > 0);
  });

  it('disables every Code node at any depth and counts them', () => {
    const r = X.disableCodeNodes(steps);
    expect(r.count).toBe(2);
    expect(r.steps[1].disabled).toBe(true);
    expect(r.steps[2].then[0].disabled).toBe(true);
    expect(r.steps[0].disabled).toBeUndefined();
    expect((steps[1] as any).disabled).toBeUndefined(); // input untouched
  });

  it('recognises a Code node by its normalised name (" code", "CODE")', () => {
    const r = X.disableCodeNodes([{ action: ' code' }, { action: 'CODE\n' }, { action: 'codex' }, { action: 'goto' }]);
    expect(r.count).toBe(2);
    expect(r.steps[0].disabled).toBe(true);
    expect(r.steps[1].disabled).toBe(true);
    expect(r.steps[2].disabled).toBeUndefined();
    expect(r.steps[3].disabled).toBeUndefined();
  });

  it('client parse() classifies bad files', () => {
    expect(X.parse('{nope').code).toBe('json');
    expect(X.parse('[]').code).toBe('shape');
    expect(X.parse('{"format":"other","version":1}').code).toBe('format');
    expect(X.parse('{"format":"plyr-workflow","version":99,"workflow":{"steps":[]}}').code).toBe('version');
    expect(X.parse('{"format":"plyr-workflow","version":1,"workflow":{}}').code).toBe('shape');
    expect(X.parse('{"name":"x","steps":[]}').legacy).toBe(true);
  });
});

describe('WorkflowExchange.parseExchange (server)', () => {
  const file = (over: any = {}) => ({ format: 'plyr-workflow', version: 1, workflow: { name: 'W', steps }, ...over });

  it('accepts a native file, disables Code nodes, and summarises', () => {
    const r = parseExchange(file());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.codeDisabled).toBe(2);
    expect(r.summary.nodeCount).toBe(4);
    expect(r.summary.codeNodes).toBe(2);
    expect(r.summary.disabledNodes).toBe(2);
    expect((r.workflow.steps[1] as any).disabled).toBe(true);
  });

  it('a Code node cannot arrive enabled, even if the file says disabled:false', () => {
    const r = parseExchange(file({ workflow: { name: 'W', steps: [{ action: 'code', disabled: false, params: { code: 'x' } }] } }));
    expect(r.ok && (r.workflow.steps[0] as any).disabled).toBe(true);
  });

  it('wraps an old plyr export', () => {
    const r = parseExchange({ name: 'Old', steps: [{ action: 'goto', params: { url: 'https://a.test' } }] });
    expect(r.ok && r.legacy).toBe(true);
  });

  it.each([
    [null, 'shape'],
    [[], 'shape'],
    [{ format: 'n8n' }, 'format'],
    [{ foo: 1 }, 'format'],
    [file({ version: 2 }), 'version'],
    [file({ version: 0 }), 'shape'],
    [file({ version: 1.5 }), 'shape'],
    [file({ workflow: { name: '', steps } }), 'shape'],
    [file({ workflow: { name: 'x', steps: [] } }), 'shape'],
    [file({ workflow: { name: 'x', steps: ['str'] } }), 'shape'],
  ])('refuses %j -> %s', (body, code) => {
    const r = parseExchange(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(code);
  });

  it('round-trips: export -> parse keeps the steps (Code disabled)', () => {
    const env = buildNativeEnvelope({ name: 'RT', steps: [{ action: 'goto', params: { url: 'https://a.test' } }] });
    const r = parseExchange(JSON.parse(JSON.stringify(env)));
    expect(r.ok && r.workflow.steps).toEqual([{ action: 'goto', params: { url: 'https://a.test' } }]);
  });
});
