export type IdentityState = 'stable' | 'rebound' | 'needs_rebind' | 'retrying' | 'invalid';

export interface ExecutionScope {
  scopeId: string;
  parentExecutionId?: string;
  profileId: string;
  /** Current Chrome incarnation. It is replaceable after recovery. */
  runtimeId?: string;
  /** Current page identity. It must be revalidated after page recovery. */
  pageId?: string;
  identityState: IdentityState;
  variables: Record<string, unknown>;
}

export interface ScopeTarget {
  profileId: string;
  runtimeId: string;
  pageId?: string;
}

export class ExecutionScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionScopeError';
  }
}

export function createExecutionScope(input: {
  scopeId: string;
  profileId: string;
  parentExecutionId?: string;
  runtimeId?: string;
  pageId?: string;
  variables?: Record<string, unknown>;
}): ExecutionScope {
  return {
    scopeId: input.scopeId,
    ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
    profileId: input.profileId,
    ...(input.runtimeId ? { runtimeId: input.runtimeId } : {}),
    ...(input.pageId ? { pageId: input.pageId } : {}),
    identityState: input.runtimeId ? 'stable' : 'needs_rebind',
    variables: { ...(input.variables || {}) },
  };
}

export function selectProfile(scope: ExecutionScope, profileId: string): ExecutionScope {
  const next = String(profileId || '').trim();
  if (!next) throw new ExecutionScopeError('A profile id is required.');
  return {
    ...scope,
    profileId: next,
    runtimeId: undefined,
    pageId: undefined,
    identityState: 'needs_rebind',
  };
}

export function rebindScope(
  scope: ExecutionScope,
  target: ScopeTarget,
): ExecutionScope {
  if (!target.profileId || !target.runtimeId) {
    throw new ExecutionScopeError('A profile and runtime are required to rebind a scope.');
  }
  if (target.profileId !== scope.profileId) {
    throw new ExecutionScopeError('A scope cannot silently rebind to another profile.');
  }
  return {
    ...scope,
    runtimeId: target.runtimeId,
    ...(target.pageId ? { pageId: target.pageId } : { pageId: undefined }),
    identityState: 'rebound',
  };
}

export function invalidateScope(scope: ExecutionScope): ExecutionScope {
  return { ...scope, identityState: 'invalid' };
}

export function assertStableIdentity(scope: ExecutionScope): void {
  if (!scope.runtimeId || scope.identityState === 'invalid' || scope.identityState === 'needs_rebind') {
    throw new ExecutionScopeError(
      `Scope ${scope.scopeId} has no stable runtime identity (${scope.identityState}).`,
    );
  }
}
