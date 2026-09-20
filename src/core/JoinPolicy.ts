export type JoinPolicy =
  | 'continue_on_error'
  | 'fail_if_any_failed'
  | 'require_n_success'
  | 'require_all_success';

export interface JoinConfig {
  policy: JoinPolicy;
  requiredSuccessCount?: number;
  timeoutMs?: number;
  cancelRemainingOnFailure?: boolean;
}

export interface JoinBranchResult<T = unknown> {
  scopeId: string;
  profileId: string;
  status: 'success' | 'failed' | 'cancelled' | 'timed_out';
  output?: T;
  error?: string;
}

export interface JoinResult<T = unknown> {
  status: 'success' | 'partial-success' | 'failed';
  successCount: number;
  failureCount: number;
  branches: Record<string, JoinBranchResult<T>>;
}

export class JoinPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JoinPolicyError';
  }
}

export function evaluateJoin<T>(
  branches: JoinBranchResult<T>[],
  config: JoinConfig,
): JoinResult<T> {
  const successCount = branches.filter((b) => b.status === 'success').length;
  const failureCount = branches.length - successCount;
  const required = config.requiredSuccessCount ?? 0;

  if (config.policy === 'require_n_success' &&
      (!Number.isInteger(required) || required < 1)) {
    throw new JoinPolicyError('require_n_success needs a positive requiredSuccessCount.');
  }

  const allSuccessful = branches.length > 0 && failureCount === 0;
  const meetsPolicy = (() => {
    switch (config.policy) {
      case 'continue_on_error':
        return successCount > 0 || branches.length === 0;
      case 'fail_if_any_failed':
      case 'require_all_success':
        return allSuccessful;
      case 'require_n_success':
        return successCount >= required;
    }
  })();

  let status: JoinResult<T>['status'];
  if (meetsPolicy && failureCount === 0) status = 'success';
  else if (meetsPolicy) status = 'partial-success';
  else status = 'failed';

  return {
    status,
    successCount,
    failureCount,
    branches: Object.fromEntries(branches.map((branch) => [branch.scopeId, branch])),
  };
}
