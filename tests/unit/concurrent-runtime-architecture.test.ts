import { describe, expect, it, vi } from 'vitest';
import {
  BrowserPageRegistry,
  PageRegistryError,
} from '../../src/core/BrowserPageRegistry';
import {
  createExecutionScope,
  rebindScope,
  selectProfile,
} from '../../src/core/ExecutionScope';
import { evaluateJoin } from '../../src/core/JoinPolicy';
import {
  ChromiumProfileManager,
  type RuntimeHandle,
} from '../../src/core/ChromiumProfileManager';

function fakePage(): any {
  return { isClosed: () => false };
}

describe('concurrent runtime architecture primitives', () => {
  it('keeps page identity independent from the UI active tab', () => {
    const registry = new BrowserPageRegistry('p1', 'p1:runtime:1');
    const page = fakePage();
    const ref = registry.register(page, { kind: 'tab' });

    expect(ref.pageId).toBe('p1:runtime:1:p1');
    expect(registry.idFor(page)).toBe(ref.pageId);
    expect(registry.get(ref.pageId)?.page).toBe(page);
  });

  it('enforces one page lease while allowing observation', () => {
    const registry = new BrowserPageRegistry('p1', 'r1');
    const ref = registry.register(fakePage(), { kind: 'tab' });
    registry.acquireLease(ref.pageId, { kind: 'automation', scopeId: 'scope-a' });

    expect(() => registry.acquireLease(ref.pageId, { kind: 'automation', scopeId: 'scope-b' }))
      .toThrow(PageRegistryError);
    expect(() => registry.acquireLease(ref.pageId, { kind: 'human', sessionId: 'view-1' }, 'observe'))
      .not.toThrow();
  });

  it('selects a new profile without silently rebinding runtime or page', () => {
    const scope = createExecutionScope({ scopeId: 's1', profileId: 'p1', runtimeId: 'r1', pageId: 'page-a' });
    const selected = selectProfile(scope, 'p2');
    expect(selected.profileId).toBe('p2');
    expect(selected.runtimeId).toBeUndefined();
    expect(selected.pageId).toBeUndefined();
    expect(selected.identityState).toBe('needs_rebind');

    const rebound = rebindScope(selected, { profileId: 'p2', runtimeId: 'r2', pageId: 'page-b' });
    expect(rebound.identityState).toBe('rebound');
    expect(rebound.pageId).toBe('page-b');
  });

  it('produces deterministic namespaced partial join output', () => {
    const result = evaluateJoin([
      { scopeId: 'a', profileId: 'p1', status: 'success', output: { result: 'A' } },
      { scopeId: 'b', profileId: 'p2', status: 'failed', error: 'boom' },
      { scopeId: 'c', profileId: 'p3', status: 'success', output: { result: 'C' } },
    ], { policy: 'continue_on_error' });

    expect(result.status).toBe('partial-success');
    expect(result.branches.a.output).toEqual({ result: 'A' });
    expect(result.branches.b.error).toBe('boom');
  });

  it('replaces only the crashed profile runtime with a new incarnation', async () => {
    let starts = 0;
    const factory = {
      start: vi.fn(async (profile: any, runtimeId: string): Promise<RuntimeHandle> => {
        starts++;
        return {
          runtimeId,
          profileId: profile.id,
          status: 'running',
          startedAt: Date.now(),
          stop: vi.fn(async () => undefined),
        };
      }),
    };
    const manager = new ChromiumProfileManager(factory);
    manager.createProfile({ id: 'p1', name: 'P1', chromeUserDataDir: '/tmp/p1' });
    manager.createProfile({ id: 'p2', name: 'P2', chromeUserDataDir: '/tmp/p2' });

    const p1r1 = await manager.start('p1');
    const p2r1 = await manager.start('p2');
    manager.markRuntimeCrashed(p2r1.runtimeId);
    const p2r2 = await manager.recover('p2');

    expect(starts).toBe(3);
    expect(manager.currentRuntime('p1')?.runtimeId).toBe(p1r1.runtimeId);
    expect(manager.currentRuntime('p2')?.runtimeId).toBe(p2r2.runtimeId);
    expect(p2r2.runtimeId).not.toBe(p2r1.runtimeId);
  });
});
