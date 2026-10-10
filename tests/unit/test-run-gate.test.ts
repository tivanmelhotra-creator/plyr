/**
 * TestRunGate + URL checks: activation is refused unless the CURRENT design
 * passed a real Execute Workflow run, and a filled-in but unusable URL
 * (`arena.ai`, no scheme) is caught before any run.
 */
import { describe, it, expect } from 'vitest';
import { designFingerprint, runnableSteps, testGateProblem } from '../../src/core/TestRunGate';
import { activationIssues, formatActivationIssue, urlProblem } from '../../src/core/ActivationCheck';

const design = [
  { action: 'goto', params: { url: 'https://arena.ai' } },
  { action: 'click', params: { selector: '#go' } },
];
const ok = (steps: unknown) => ({ status: 'success' as const, fingerprint: designFingerprint(steps), jobId: 'j1', finishedAt: 'now' });

describe('urlProblem / activation URL check', () => {
  it('refuses a URL without a scheme - the exact page.goto failure from the report', () => {
    expect(urlProblem('arena.ai')).toMatch(/incomplete URL "arena\.ai" - add https:\/\//);
    expect(urlProblem('localhost:3000')).toMatch(/incomplete URL/);
    expect(urlProblem('www.example.com/path')).toMatch(/incomplete URL/);
  });
  it('accepts real URLs and run-time expressions', () => {
    for (const u of ['https://arena.ai', 'http://localhost:3000/x', 'about:blank', '{{ $json.url }}', 'https://{{host}}/a']) {
      expect(urlProblem(u), u).toBeNull();
    }
  });
  it('rejects unsupported schemes', () => {
    expect(urlProblem('javascript:alert(1)')).toMatch(/unsupported scheme/);
    expect(urlProblem('ftp://x.example')).toMatch(/unsupported scheme/);
  });
  it('is reported as a blocking activation issue with the node path', () => {
    const out = activationIssues([{ action: 'goto', params: { url: 'arena.ai' } }]).map(formatActivationIssue);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^Node 1 \(goto\) has an incomplete URL/);
    expect(activationIssues([{ action: 'http-request', params: { url: 'api.x.com/v1' } }])).toHaveLength(1);
  });
});

describe('designFingerprint', () => {
  it('ignores disabled nodes, like the test run does (document form == run form)', () => {
    const doc = [...design, { action: 'hover', params: { selector: 'a' }, disabled: true }];
    expect(designFingerprint(doc)).toBe(designFingerprint(design));
    expect(runnableSteps(doc)).toHaveLength(2);
  });
  it('ignores key order and empty-string params, changes on a real edit', () => {
    const reordered = [{ params: { url: 'https://arena.ai', note: '' }, action: 'goto' }, design[1]];
    expect(designFingerprint(reordered)).toBe(designFingerprint(design));
    const edited = [design[0], { action: 'click', params: { selector: '#other' } }];
    expect(designFingerprint(edited)).not.toBe(designFingerprint(design));
  });
  it('walks nested branches', () => {
    const a = [{ action: 'if', then: [{ action: 'click', params: { selector: '#a' } }, { action: 'x', disabled: true }] }];
    const b = [{ action: 'if', then: [{ action: 'click', params: { selector: '#a' } }] }];
    expect(designFingerprint(a)).toBe(designFingerprint(b));
  });
});

describe('testGateProblem', () => {
  it('passes only with a successful test of THIS design', () => {
    expect(testGateProblem(design, ok(design))).toBeNull();
  });
  it('refuses a never-tested workflow', () => {
    expect(testGateProblem(design, null)).toMatch(/never been tested/);
  });
  it('refuses when the design changed after the test', () => {
    const edited = [design[0], { action: 'click', params: { selector: '#new' } }];
    expect(testGateProblem(edited, ok(design))).toMatch(/changed after its last test run/);
  });
  it('refuses a failed test and says where and why (no double period)', () => {
    const msg = testGateProblem(design, {
      ...ok(design), status: 'error', error: 'page.goto: Protocol error',
      failedStep: { step: 2, action: 'click', error: 'locator.waitFor: Timeout 3000ms exceeded.\nCall log' },
    });
    expect(msg).toMatch(/failed at step 2 \(click\): locator\.waitFor: Timeout 3000ms exceeded\. Fix it/);
  });
  it('refuses a cancelled test', () => {
    expect(testGateProblem(design, { ...ok(design), status: 'cancelled' })).toMatch(/stopped before it finished/);
  });
});
