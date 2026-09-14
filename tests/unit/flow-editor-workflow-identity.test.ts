/**
 * flow-editor-workflow-identity.test.ts — S14 / P4
 *
 * REPORTED: open a saved workflow, reload the page, open the Local Browser:
 * the Workflow Files drawer said the browser "was not opened from a saved
 * workflow" and every file the operator had filed was gone from view.
 *
 * MEASURED cause (public/js/flow-editor.js): the GRAPH came back from
 * localStorage (LS_KEY 'ab_flow_graph') but `currentWorkflow` lived only in
 * memory, so FlowEditor.getCurrentWorkflow() answered null after a reload and
 * every consumer -- workflowIdFor() in browser-view.js, the NDV pairing key,
 * the run panel, the Save button (create instead of update) -- built its
 * request with workflowId ''.
 *
 * The fix stores the workflow IDENTITY beside the graph (LS_WF_KEY
 * 'ab_flow_workflow'), never inside serialize() (undo/clipboard reuse that),
 * and restores it in loadLocal(). This test loads the real flow-editor.js
 * under a minimal window shim with a fake localStorage (node:vm, no DOM: the
 * editor is never mounted, `dom` stays null) and asserts the contract.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

interface WorkflowMeta { id: string; name?: string; description?: string; version?: number; headless?: boolean; webhookUrl?: string }
interface FE {
  openWorkflow: (meta: WorkflowMeta | null, steps: unknown[]) => void;
  newWorkflow: () => void;
  getCurrentWorkflow: () => WorkflowMeta | null;
  setCurrentWorkflow: (meta: WorkflowMeta | null) => void;
  saveLocal: () => boolean;
  loadLocal: () => boolean;
  reset: () => void;
  toSteps: () => unknown[];
}

/** A localStorage that survives "reloads": the store is shared, the page is not. */
function fakeStorage(store: Map<string, string>) {
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
  };
}

/** Boot a fresh page (fresh window, same localStorage) and return FlowEditor. */
function boot(store: Map<string, string>): FE {
  const win: Record<string, unknown> = {};
  win.localStorage = fakeStorage(store);
  win.addEventListener = () => undefined;
  // The editor registers one global Escape handler at load; nothing is mounted.
  const document = { addEventListener: () => undefined };
  win.document = document;
  const sandbox = { window: win, document, localStorage: win.localStorage, console, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const f of ['actions.js', 'graph-serialize.js', 'flow-editor.js']) {
    const code = readFileSync(join(__dirname, '..', '..', 'public', 'js', f), 'utf8');
    vm.runInContext(code, sandbox, { filename: f });
  }
  const fe = win.FlowEditor as FE;
  if (!fe) throw new Error('flow-editor.js did not expose window.FlowEditor');
  return fe;
}

const META: WorkflowMeta = { id: 'wf_abc123', name: 'Invoices', description: 'monthly', version: 3, headless: false, webhookUrl: '' };
const STEPS = [{ action: 'goto', params: { url: 'https://example.com' } }];

describe('the saved workflow\u2019s identity survives a reload with its graph', () => {
  let store: Map<string, string>;
  beforeEach(() => { store = new Map(); });

  it('openWorkflow writes graph AND identity; a fresh page restores both', () => {
    const fe = boot(store);
    fe.openWorkflow(META, STEPS);
    expect(fe.getCurrentWorkflow()?.id).toBe('wf_abc123');
    expect(store.has('ab_flow_graph')).toBe(true);
    expect(store.has('ab_flow_workflow')).toBe(true);

    // "Reload": new window, same localStorage, before any openWorkflow call.
    const fe2 = boot(store);
    expect(fe2.getCurrentWorkflow()).toBeNull();
    expect(fe2.loadLocal()).toBe(true);
    const cur = fe2.getCurrentWorkflow();
    expect(cur).not.toBeNull();
    expect(cur!.id).toBe('wf_abc123');
    expect(cur!.name).toBe('Invoices');
    expect(cur!.version).toBe(3);
    expect(fe2.toSteps()).toEqual(STEPS);
  });

  it('the identity is NOT inside the graph blob (undo/clipboard reuse serialize())', () => {
    const fe = boot(store);
    fe.openWorkflow(META, STEPS);
    const graph = JSON.parse(store.get('ab_flow_graph')!);
    expect(graph.nodes).toBeDefined();
    expect(JSON.stringify(graph)).not.toContain('wf_abc123');
  });

  it('a new workflow\u2019s FIRST save (setCurrentWorkflow) is the identity a reload comes back with', () => {
    const fe = boot(store);
    fe.newWorkflow();
    expect(fe.getCurrentWorkflow()).toBeNull();
    expect(store.has('ab_flow_workflow')).toBe(false);
    // The server answered the POST with the newly born id.
    fe.setCurrentWorkflow({ id: 'wf_new9', name: 'Fresh' });
    fe.saveLocal();

    const fe2 = boot(store);
    fe2.loadLocal();
    expect(fe2.getCurrentWorkflow()?.id).toBe('wf_new9');
  });

  it('newWorkflow and reset forget the identity, so a reload does not resurrect the old workflow', () => {
    const fe = boot(store);
    fe.openWorkflow(META, STEPS);
    fe.newWorkflow();
    expect(store.has('ab_flow_workflow')).toBe(false);
    let fe2 = boot(store);
    fe2.loadLocal();
    expect(fe2.getCurrentWorkflow()).toBeNull();

    fe.openWorkflow(META, STEPS);
    expect(store.has('ab_flow_workflow')).toBe(true);
    fe.reset();
    expect(store.has('ab_flow_workflow')).toBe(false);
    fe2 = boot(store);
    fe2.loadLocal();
    expect(fe2.getCurrentWorkflow()).toBeNull();
  });

  it('a corrupt or id-less identity record is ignored, not thrown', () => {
    const fe = boot(store);
    fe.openWorkflow(META, STEPS);
    store.set('ab_flow_workflow', '{not json');
    const fe2 = boot(store);
    expect(fe2.loadLocal()).toBe(true);
    expect(fe2.getCurrentWorkflow()).toBeNull();

    store.set('ab_flow_workflow', JSON.stringify({ name: 'no id' }));
    const fe3 = boot(store);
    expect(fe3.loadLocal()).toBe(true);
    expect(fe3.getCurrentWorkflow()).toBeNull();
  });
});
