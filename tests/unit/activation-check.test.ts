/**
 * ActivationCheck: what refuses an activation. Every blocking problem must be
 * reported at once (with a findable node path), disabled nodes must not count,
 * and the legacy autosave history cleanup must never touch a manual save.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activationIssues, formatActivationIssue } from '../../src/core/ActivationCheck';
import { openSqlite } from '../../src/core/SqliteStore';
import { SqliteWorkflowRepository } from '../../src/services/workflow.repository';
import { pruneLegacyAutosavesOnce } from '../../src/services/storage';
import { WorkflowService } from '../../src/services/workflow.service';

const msgs = (steps: unknown, opts = {}) => activationIssues(steps, opts).map(formatActivationIssue);

describe('activationIssues', () => {
  it('accepts a valid design', () => {
    expect(msgs([{ action: 'goto', params: { url: 'https://a.example' } }, { action: 'click', params: { selector: '#b' } }])).toEqual([]);
  });

  it('refuses an empty design and an all-disabled design', () => {
    expect(msgs([])).toEqual(['The workflow has no nodes']);
    expect(msgs([{ action: 'goto', params: {}, disabled: true }])).toEqual(['Every node is disabled']);
  });

  it('reports every problem, including nested branches, and skips disabled nodes', () => {
    const out = msgs([
      { action: 'goto', params: {} },
      { action: 'if', params: {}, then: [{ action: 'fill', params: { text: 'x' } }], else: [{ action: 'mystery', params: {} }] },
      { action: 'upload', params: { selector: '#f' } },
      { action: 'click', params: {}, disabled: true },
      { action: 'switch', params: {} },
    ]);
    expect(out).toEqual([
      'Node 1 (goto) needs a URL',
      'Node 2.then.1 (fill) needs a selector',
      'Node 2.else.1 (mystery) uses an unknown action "mystery"',
      'Node 3 (upload) needs a file path',
      'Node 5 (switch) needs a variable',
    ]);
  });

  it('treats {{ expressions }} as present (resolved at run time)', () => {
    expect(msgs([{ action: 'goto', params: { url: '{{ $json.url }}' } }])).toEqual([]);
  });

  it('refuses a Code node when Code nodes are disabled on the server', () => {
    expect(msgs([{ action: 'code', params: { code: 'return 1' } }], { codeNodeEnabled: false }))
      .toEqual(['Node 1 (code) is a Code node, but Code nodes are disabled on this server']);
    expect(msgs([{ action: 'code', params: { code: 'return 1' } }], { codeNodeEnabled: true })).toEqual([]);
  });

  it('accepts runtime aliases, triggers and installed modules', () => {
    expect(msgs([{ action: 'trigger_manual', params: {} }, { action: 'navigate', params: { url: 'https://x' } }])).toEqual([]);
    expect(msgs([{ action: 'my-module', params: {} }], { moduleExists: (a: string) => a === 'my-module' })).toEqual([]);
  });
});

describe('legacy autosave cleanup (SQLite, boot)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  it('keeps manual + oldest auto (re-tagged initial), removes the rest, runs once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-prune-'));
    dirs.push(dir);
    const db = openSqlite(path.join(dir, 'p.db'));
    const repo = new SqliteWorkflowRepository(db);
    const snap = (version: number, kind?: 'manual') => ({ version, name: `v${version}`, steps: [], savedAt: 't', ...(kind ? { kind } : {}) });
    // An old build's history: v3..v7 autosaves (v1/v2 trimmed away), one manual save.
    for (const v of [3, 4, 5, 6, 7]) await repo.saveVersion('u', 'wf_a', snap(v));
    await repo.saveVersion('u', 'wf_a', snap(1_000_000_001, 'manual'));
    // A second workflow that still has its creation row.
    for (const v of [1, 2]) await repo.saveVersion('u', 'wf_b', snap(v));

    expect(pruneLegacyAutosavesOnce(db)).toBe(5);
    const a = await repo.listVersions('u', 'wf_a');
    expect(a.map((s) => [s.version, s.kind])).toEqual([[1_000_000_001, 'manual'], [3, 'initial']]);
    const b = await repo.listVersions('u', 'wf_b');
    expect(b.map((s) => [s.version, s.kind])).toEqual([[1, 'initial']]);

    // Idempotent: the marker stops a second pass even if new rows appear.
    await repo.saveVersion('u', 'wf_b', snap(9));
    expect(pruneLegacyAutosavesOnce(db)).toBe(0);
  });

  it('a workflow created now writes one tagged initial row and autosave never adds more', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plyr-prune-'));
    dirs.push(dir);
    const svc = new WorkflowService(new SqliteWorkflowRepository(openSqlite(path.join(dir, 's.db'))));
    const wf = await svc.create('u', { name: 'N', steps: [] });
    for (let i = 0; i < 1000; i++) await svc.update('u', wf.id, { name: `N${i}`, steps: [] });
    const all = await svc.listAllVersions('u', wf.id);
    expect(all.map((s) => s.kind)).toEqual(['initial']);
    expect((await svc.get('u', wf.id))?.version).toBe(1001);
  });
});
