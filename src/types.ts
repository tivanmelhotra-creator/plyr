import type { BrowserContext, Page } from 'playwright';
import type { Job } from 'bullmq';
import type { ProfileManager } from './core/ProfileManager';
import type { PlanConfig } from './config';
import type { Condition } from './core/ConditionEngine';
import type { QuotaManager } from './core/QuotaManager';
import type { WorkflowItem } from './core/WorkflowItems';

// ============================================
// Step Output
// ============================================
export interface StepOutput {
  step: number;
  action: string;
  success: boolean;
  result?: unknown;
  error?: string;
  timestamp: string;
  durationMs: number;
  // Step 21 (item-based data model): how many items flowed in/out of
  // this step and a small JSON-safe preview of the output items.
  inputItemCount?: number;
  outputItemCount?: number;
  outputSample?: Record<string, unknown>[];
  outputTruncated?: boolean;
}

// ============================================
// Job Result
// ============================================
export interface JobResult {
  success: boolean;
  message: string;
  currentUrl?: string;
  error?: string;
  durationMs?: number;
  cancelledByUser?: boolean;
  userCancelled?: boolean;
  note?: string;
  result?: unknown;
  failedByUser?: boolean;
  // Schedule Support
  isScheduled?: boolean;
  scheduleName?: string;
}

// ============================================
// Cancel Checker
// ============================================
export type CancelChecker = () => boolean | Promise<boolean>;

// ============================================
// Active Context Entry
// ============================================
export interface ActiveContextEntry {
  context: BrowserContext;
  lastActivity: number;
  jobId: string;
}

// ============================================
// Automation Step
// ============================================
export interface AutomationStep {
  action: string;
  params?: Record<string, unknown>;
  saveAs?: string;
  condition?: Condition;
  then?: AutomationStep[];
  else?: AutomationStep[];
  steps?: AutomationStep[];
  catch?: AutomationStep[];
  finally?: AutomationStep[];
  cases?: Record<string, AutomationStep[]>;

  // ── Step 27: per-step error handling (n8n-grade) ──
  /** Swallow this step's error and continue with the next step. */
  continueOnFail?: boolean;
  /** Re-run this step on failure up to `maxTries` times. */
  retryOnFail?: boolean;
  /** Total attempts when retryOnFail is on (>=1, capped). */
  maxTries?: number;
  /** Base wait between retry attempts, in milliseconds. */
  waitBetweenTriesMs?: number;
}

// ============================================
// Automation Context
// ============================================
export interface AutomationContext {
  userId: string;
  profileManager: ProfileManager;
  log: (msg: string) => void;
  // Step 16: optional live event hook (step.start/step.done/step.error).
  onEvent?: (type: string, data?: Record<string, unknown>) => void;
  jobId: string;
  job?: Job;
  getModule: (name: string) => unknown;
  isCancelled: CancelChecker;
  headless: boolean;
  stepOutputs: StepOutput[];
  browserContext?: BrowserContext;
  page?: Page;
  data: Record<string, unknown>;
  userPlan: PlanConfig;
  variables: Map<string, unknown>;
  globalLoopCounter: number;
  quotaManager: QuotaManager;
  // Step 21 (item-based data model): the uniform item stream flowing
  // between steps (n8n-style). Starts as a single empty item.
  items: WorkflowItem[];
  // Per-node output memory keyed by a node identity (saveAs or
  // action#index), enabling future $node["name"].json expressions.
  nodeOutputs: Record<string, WorkflowItem[]>;
}

// ============================================
// Webhook Payload
// ============================================
export interface WebhookPayload {
  event: string;
  jobId: string;
  userId: string;
  success: boolean;
  message?: string;
  error?: string;
  durationMs?: number;
  stepsCount?: number;
  stepsCompleted?: number;
  timestamp: string;
  // Schedule Info
  isScheduled?: boolean;
  scheduleName?: string;
}

// ============================================
// Persisted Job Data
// ============================================
export interface PersistedJobData {
  jobId: string;
  userId: string;
  state: 'completed' | 'failed';
  progress: number;
  finishedOn: string;
  stepOutputs: StepOutput[];
  success: boolean;
  message?: string;
  error?: string;
  durationMs?: number;
  cancelledByUser?: boolean;
  blocked?: boolean;
  // Schedule Info
  isScheduled?: boolean;
  scheduleName?: string;
}

// ============================================
// User Settings Filter
// ============================================
export interface UserSettingsFilter {
  blocked?: boolean;
  sequential?: boolean;
}

// ============================================
// Bulk Operation Result
// ============================================
export interface BulkOperationResult {
  successful: string[];
  failed: Array<{ userId: string; error: string }>;
  skipped: string[];
}

// ============================================
// Schedule Types (NEW)
// ============================================
export interface ScheduleInfo {
  key: string;
  scheduleId: string;
  name: string;
  cron: string;
  nextRun: string;
  createdAt: string | null;
  timezone: string;
}

export interface ScheduleCreateRequest {
  userId: string;
  name?: string;
  cron: string;
  steps: AutomationStep[];
  headless?: boolean;
  webhookUrl?: string;
}

export interface ScheduleCreateResponse {
  success: boolean;
  message: string;
  schedule: {
    id: string;
    key: string | null;
    name: string;
    cron: string;
    nextRun: string;
    runsLimit: number | 'unlimited';
  };
  currentSchedules: number;
  maxSchedules: number;
  userType: 'VIP' | 'Free';
}

// ============================================
// Job Data (Internal Queue Data)
// ============================================
export interface JobData {
  userId: string;
  steps: AutomationStep[];
  headless: boolean;
  webhookUrl?: string;
  // Cancellation Flag
  __cancelledByUser?: boolean;
  // Schedule Metadata
  __scheduled?: boolean;
  __scheduleName?: string;
  __scheduleId?: string;
}

// ============================================
// Action Result Types (for specific actions)
// ============================================
export interface ScreenshotResult {
  path: string;
  size: number;
  width?: number;
  height?: number;
}

export interface HttpRequestResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

export interface ExtractResult {
  selector: string;
  count: number;
  data: unknown[];
}

export interface WaitResult {
  waited: boolean;
  durationMs: number;
  found?: boolean;
}

// ============================================
// Queue Job Info (for API responses)
// ============================================
export interface QueueJobInfo {
  jobId: string;
  state: string;
  progress: number | object;
  timestamp: string | null;
  failedReason?: string;
  isScheduled: boolean;
  scheduleName: string | null;
}

// ============================================
// Live Status (for active jobs)
// ============================================
export interface LiveStatus {
  message: string;
  currentUrl: string;
  stepIndex: number;
}

// ============================================
// Job Detail Response
// ============================================
export interface JobDetailResponse {
  success: boolean;
  jobId: string;
  state: string;
  progress?: number | object;
  isScheduled?: boolean;
  liveStatus?: LiveStatus;
  stepOutputs?: StepOutput[];
  queueInfo?: {
    totalWaiting: number;
    message: string;
  };
  recovered?: boolean;
  message?: string;
  userId?: string;
}

// ============================================
// Workflow Storage (Step 17, category G2)
// A reusable, versioned, user-owned bundle of automation steps that can be
// saved, listed, edited, re-run and version-tracked from any client.
// ============================================
export interface Workflow {
  id: string;
  userId: string;
  name: string;
  description?: string;
  steps: unknown[];
  headless?: boolean | string | number | null;
  webhookUrl?: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// A point-in-time snapshot kept in the version history of a workflow.
export interface WorkflowVersionSnapshot {
  version: number;
  name: string;
  description?: string;
  steps: unknown[];
  headless?: boolean | string | number | null;
  webhookUrl?: string | null;
  savedAt: string;
}
