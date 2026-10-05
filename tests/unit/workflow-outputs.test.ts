/**
 * WorkflowOutputs - node output files live in the workflow's OWN workspace,
 * one folder per node under downloads/, created once and reused.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-outputs-'));
vi.mock('../../src/config', () => ({
  config: { WORKFLOW_STORAGE_ROOT: tmpRoot, IS_SINGLE_USER: false },
}));

const {
  workspaceOf, nodeFolderName, fileStamp, workspaceFileUrl, mimeForName,
  saveNodeBytes, saveNodeFileFrom,
} = await import('../../src/core/WorkflowOutputs');
const { WorkflowStorage } = await import('../../src/core/WorkflowStorage');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const WF = 'wf_b82fb9d4802e3345';
const OTHER = 'wf_0000000000000001';

afterAll(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

describe('workspaceOf - trust nothing that travelled through Redis', () => {
  it('accepts a well-formed stamp', () => {
    expect(workspaceOf({ __workspace: { owner: 'local', workflowId: WF } })).toEqual({ owner: 'local', workflowId: WF });
  });
  it.each([
    undefined, null, {}, { __workspace: null }, { __workspace: 'x' },
    { __workspace: { owner: '../x', workflowId: WF } },
    { __workspace: { owner: 'local', workflowId: '../../etc' } },
    { __workspace: { owner: 'local', workflowId: 'a/b' } },
    { __workspace: { owner: 7, workflowId: WF } },
    { __workspace: { owner: 'local' } },
  ])('rejects %j', (d) => expect(workspaceOf(d)).toBeNull());
});

describe('nodeFolderName', () => {
  it('numbers by position and names by action', () => {
    expect(nodeFolderName(4, 'screenshot')).toBe('04-screenshot');
    expect(nodeFolderName(12, 'export-data')).toBe('12-export-data');
  });
  it('can only ever produce a plain path segment', () => {
    for (const a of ['../../x', 'a/b', 'A B', '', '..', 'x\u0000y', '<script>']) {
      const f = nodeFolderName(3, a);
      expect(f).toMatch(/^\d{2,}-[a-z0-9_-]+$/);
      expect(f).not.toMatch(/[./\\]/);
    }
  });
});

describe('fileStamp / mime / url', () => {
  it('stamps in sortable UTC', () => {
    expect(fileStamp(new Date(Date.UTC(2026, 9, 5, 21, 27, 47)))).toBe('20261005-212747');
  });
  it('maps image types', () => {
    expect(mimeForName('a.PNG')).toBe('image/png');
    expect(mimeForName('a.jpg')).toBe('image/jpeg');
    expect(mimeForName('a.bin')).toBe('application/octet-stream');
  });
  it('url points at the existing Workflow Files download route, not a new door', () => {
    expect(workspaceFileUrl('local', WF, 'downloads/04-screenshot/a b.png')).toBe(
      `/browser/workflow-files/${WF}/download?path=downloads%2F04-screenshot%2Fa%20b.png&userId=local`,
    );
  });
});

describe('saveNodeBytes', () => {
  const ws = { owner: 'local', workflowId: WF };
  const node = { stepNumber: 4, action: 'screenshot' };

  it('creates downloads/<node> on first use and writes the file there', async () => {
    const ref = await saveNodeBytes(ws, node, 'shot.png', PNG);
    expect(ref.folder).toBe('downloads/04-screenshot');
    expect(ref.path).toBe('downloads/04-screenshot/shot.png');
    expect(ref.mimeType).toBe('image/png');
    expect(ref.size).toBe(PNG.length);
    const onDisk = await fs.readFile(path.join(tmpRoot, 'local', WF, 'downloads', '04-screenshot', 'shot.png'));
    expect(onDisk.equals(PNG)).toBe(true);
  });

  it('REUSES the folder on the next run and never overwrites', async () => {
    const before = await fs.stat(path.join(tmpRoot, 'local', WF, 'downloads', '04-screenshot'));
    const ref = await saveNodeBytes(ws, node, 'shot.png', PNG);
    expect(ref.path).toBe('downloads/04-screenshot/shot (2).png');
    const names = await fs.readdir(path.join(tmpRoot, 'local', WF, 'downloads'));
    expect(names.filter((n) => n.endsWith('screenshot'))).toEqual(['04-screenshot']);
    const after = await fs.stat(path.join(tmpRoot, 'local', WF, 'downloads', '04-screenshot'));
    expect(after.ino).toBe(before.ino);
  });

  it('gives each node its own folder', async () => {
    const ref = await saveNodeBytes(ws, { stepNumber: 7, action: 'screenshot' }, 'shot.png', PNG);
    expect(ref.folder).toBe('downloads/07-screenshot');
  });

  it('keeps workflows apart', async () => {
    await saveNodeBytes({ owner: 'local', workflowId: OTHER }, node, 'shot.png', PNG);
    const a = await new WorkflowStorage('local', WF).list('downloads/04-screenshot');
    const b = await new WorkflowStorage('local', OTHER).list('downloads/04-screenshot');
    expect(a.entries.map((e) => e.name)).toContain('shot (2).png');
    expect(b.entries.map((e) => e.name)).toEqual(['shot.png']);
  });

  it('keeps users apart', async () => {
    await saveNodeBytes({ owner: 'alice', workflowId: WF }, node, 'a.png', PNG);
    const mine = await new WorkflowStorage('local', WF).list('downloads/04-screenshot');
    expect(mine.entries.map((e) => e.name)).not.toContain('a.png');
  });

  it('uses a node folder that already exists (e.g. made by hand)', async () => {
    const store = new WorkflowStorage('local', WF);
    await store.mkdir('downloads', '09-screenshot');
    const ref = await saveNodeBytes(ws, { stepNumber: 9, action: 'screenshot' }, 'x.png', PNG);
    expect(ref.path).toBe('downloads/09-screenshot/x.png');
  });

  it('survives the operator deleting downloads/ (recreated on next write)', async () => {
    await fs.rm(path.join(tmpRoot, 'local', WF, 'downloads'), { recursive: true, force: true });
    const ref = await saveNodeBytes(ws, node, 'again.png', PNG);
    expect(ref.path).toBe('downloads/04-screenshot/again.png');
  });

  it('refuses a name that would leave the folder', async () => {
    const ref = await saveNodeBytes(ws, node, '../../escape.png', PNG);
    expect(ref.path.startsWith('downloads/04-screenshot/')).toBe(true);
    await expect(fs.stat(path.join(tmpRoot, 'local', 'escape.png'))).rejects.toThrow();
  });
});

describe('saveNodeFileFrom', () => {
  it('copies a server-side file in and leaves the source alone', async () => {
    const src = path.join(tmpRoot, 'source.csv');
    await fs.writeFile(src, 'a,b\n1,2\n');
    const ref = await saveNodeFileFrom({ owner: 'local', workflowId: WF }, { stepNumber: 2, action: 'export-data' }, 'out.csv', src);
    expect(ref.path).toBe('downloads/02-export-data/out.csv');
    expect(ref.mimeType).toBe('text/csv');
    expect((await fs.readFile(src, 'utf8'))).toBe('a,b\n1,2\n');
  });
});
