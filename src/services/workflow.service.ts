import type IORedis from 'ioredis';
import { randomBytes } from 'crypto';

import { config } from '../config';
import type { Workflow, WorkflowActiveSnapshot, WorkflowVersionSnapshot } from '../types';
import {
  RedisWorkflowRepository,
  type WorkflowRepository,
} from './workflow.repository';

// ============================================================
// Workflow Storage service (Step 17, category G2)
//
// A single source of truth for saving/loading reusable, versioned workflows.
// Persistence is delegated to a WorkflowRepository (SQLite by default, Redis
// with STORAGE_DRIVER=redis — see workflow.repository.ts / storage.ts). CRUD endpoints, the re-run endpoint, API clients and the UI all go
// through here so every client sees the same records and the same version
// history. Everything is scoped per-user; ids are server-generated.
// ============================================================

// Fields a client may supply when creating/updating a workflow. id/userId/
// version/timestamps are always assigned by the server.
export interface WorkflowInput {
  name: string;
  description?: string | null;
  steps: unknown[];
  headless?: boolean | string | number | null;
  webhookUrl?: string | null;
  /** Stable default profile; runtime is resolved per execution. */
  profileId?: string | null;
  // Optional on create (defaults below). On UPDATE they are ignored: the

  // Workspace switches are owned by setState(), so saving a new design in the
  // editor can never silently re-enable a workflow the user disabled.
  active?: boolean | null;
  liveBrowser?: boolean | null;
}

// The two Workspace row switches (docs/uiux/workspace-overview.md section 4).
// Both are optional so a caller may flip only one of them.
export interface WorkflowStateInput {
  active?: boolean;
  liveBrowser?: boolean;
  /**
   * Required when `active` is set to true. The caller (the route) validates the
   * design against the user's plan FIRST and passes the result here, so the
   * frozen snapshot is always a design that was accepted at activation time.
   */
  activeSnapshot?: WorkflowActiveSnapshot;
}

// Stored label for a manual save is capped so a version list stays readable.
const MAX_LABEL_LENGTH = 120;
// Manual snapshots are numbered from here so they can never collide with autosave numbers.
export const MANUAL_VERSION_BASE = 1_000_000_000;

// A brand-new workflow is runnable immediately (that is what creating it means),
// but its browser is NOT streamed until the user opts in.
const DEFAULT_ACTIVE = true;
const DEFAULT_LIVE_BROWSER = false;

// Generate a short, URL-safe, collision-resistant workflow id (16 hex chars).
const generateWorkflowId = (): string => `wf_${randomBytes(8).toString('hex')}`;

const nowIso = (): string => new Date().toISOString();

export class WorkflowService {
  private repo: WorkflowRepository;

  /**
   * Accepts a repository, or (legacy call sites and tests) an IORedis
   * connection, which is wrapped in the Redis repository.
   */
  constructor(store: IORedis | WorkflowRepository) {
    this.repo = isRepository(store) ? store : new RedisWorkflowRepository(store);
  }

  get driver(): 'redis' | 'sqlite' {
    return this.repo.driver;
  }

  // Build a version snapshot from a stored workflow record.
  private static toSnapshot(wf: Workflow): WorkflowVersionSnapshot {
    return {
      version: wf.version,
      name: wf.name,
      description: wf.description,
      steps: wf.steps,
      headless: wf.headless,
      webhookUrl: wf.webhookUrl,
      profileId: wf.profileId,
      savedAt: wf.updatedAt,

      active: wf.active,
      liveBrowser: wf.liveBrowser,
    };
  }

  /**
   * Normalise a record read back from storage.
   *
   * `active` / `liveBrowser` were introduced after workflows had already been
   * persisted, so stored JSON may not carry them. Rather than migrate the data
   * we default them on read: an existing workflow keeps working (active), and
   * nothing starts streaming a browser behind the user's back.
   */
  private static hydrate(wf: Workflow): Workflow {
    return {
      ...wf,
      active: typeof wf.active === 'boolean' ? wf.active : DEFAULT_ACTIVE,
      liveBrowser:
        typeof wf.liveBrowser === 'boolean' ? wf.liveBrowser : DEFAULT_LIVE_BROWSER,
    };
  }

  // Persist a version snapshot + trim history to WORKFLOW_MAX_VERSIONS, dropping
  // the oldest entries so the history never grows unbounded.
  private async saveVersion(wf: Workflow): Promise<void> {
    await this.repo.saveVersion(wf.userId, wf.id, { ...WorkflowService.toSnapshot(wf), kind: 'auto' });
    await this.repo.trimVersions(wf.userId, wf.id, config.WORKFLOW_MAX_VERSIONS);
  }

  /**
   * The steps a BACKGROUND run (trigger, schedule, API) must execute. An active
   * workflow runs its frozen activation snapshot, never the live design, so
   * Editor changes cannot alter an automation that is already running.
   * Falls back to the live design only for records that predate snapshots and
   * are still active; the route re-freezes them on the next activation.
   */
  static executableDesign(wf: Workflow): { steps: unknown[]; name: string; headless?: Workflow['headless']; webhookUrl?: string | null; profileId?: string; version: number; frozen: boolean } {
    if (wf.activeSnapshot) {
      const snap = wf.activeSnapshot;
      return {
        steps: snap.steps, name: snap.name, headless: snap.headless,
        webhookUrl: snap.webhookUrl, profileId: snap.profileId,
        version: snap.version, frozen: true,
      };
    }
    return {
      steps: wf.steps, name: wf.name, headless: wf.headless,
      webhookUrl: wf.webhookUrl, profileId: wf.profileId,
      version: wf.version, frozen: false,
    };
  }

  // Create and persist a new workflow (version 1).
  async create(userId: string, input: WorkflowInput): Promise<Workflow> {
    const id = generateWorkflowId();
    const ts = nowIso();
    const wf: Workflow = {
      id,
      userId,
      name: input.name,
      description: input.description ?? undefined,
      steps: input.steps,
      headless: input.headless ?? undefined,
      webhookUrl: input.webhookUrl ?? undefined,
      profileId: input.profileId ?? undefined,
      version: 1,

      createdAt: ts,
      updatedAt: ts,
      active: typeof input.active === 'boolean' ? input.active : DEFAULT_ACTIVE,
      liveBrowser:
        typeof input.liveBrowser === 'boolean' ? input.liveBrowser : DEFAULT_LIVE_BROWSER,
    };
    await this.repo.save(wf);
    await this.saveVersion(wf);
    return wf;
  }

  // Fetch a single workflow, or null if it does not exist for this user.
  async get(userId: string, workflowId: string): Promise<Workflow | null> {
    const raw = await this.repo.get(userId, workflowId);
    if (!raw) return null;
    // Read-only: no write on read. Legacy active records without a snapshot are
    // frozen by the next activation (PATCH state); until then background runs
    // use `executableDesign`, which reports `frozen:false` for them.
    return WorkflowService.hydrate(raw);
  }

  // List all workflows owned by a user (newest updated first).
  async list(userId: string): Promise<Workflow[]> {
    const out = (await this.repo.list(userId)).map((w) => WorkflowService.hydrate(w));
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  // Update a workflow's editable fields (autosave). Bumps the design version
  // and replaces the single current state; it never creates a history entry.
  // Returns null if the workflow does not exist for this user.
  async update(
    userId: string,
    workflowId: string,
    input: WorkflowInput
  ): Promise<Workflow | null> {
    const existing = await this.get(userId, workflowId);
    if (!existing) return null;
    const updated: Workflow = {
      ...existing,
      name: input.name,
      description: input.description ?? undefined,
      steps: input.steps,
      headless: input.headless ?? undefined,
      webhookUrl: input.webhookUrl ?? undefined,
      profileId: input.profileId ?? existing.profileId,
      version: existing.version + 1,

      updatedAt: nowIso(),
      // Design edits never touch the Workspace switches (see WorkflowInput).
      active: existing.active,
      liveBrowser: existing.liveBrowser,
      // The frozen activation snapshot is independent of the editable design:
      // an Editor save must never change what an active workflow executes.
      activeSnapshot: existing.activeSnapshot ?? null,
    };
    // Autosave: the current state is the single live record. No history entry
    // is written per edit - history only grows through explicit manual saves
    // (saveManual) so a long editing session cannot flood storage.
    await this.repo.save(updated);
    return updated;
  }

  /**
   * Flip the Workspace row switches WITHOUT bumping the version and WITHOUT
   * writing a history snapshot - toggling a switch is not a new design of the
   * automation (docs/uiux/workspace-overview.md section 6, B2). `updatedAt` is
   * still refreshed so the Workspace list keeps sorting by real activity.
   *
   * Returns the updated record, or null if it does not exist for this user.
   */
  async setState(
    userId: string,
    workflowId: string,
    state: WorkflowStateInput
  ): Promise<Workflow | null> {
    const existing = await this.get(userId, workflowId);
    if (!existing) return null;

    let activeSnapshot = existing.activeSnapshot ?? null;
    let active = existing.active;
    if (state.active === true) {
      // Activation freezes the design that was validated by the caller. An
      // already-active workflow asked to activate again is re-frozen too: that
      // is the explicit "deactivate, then activate" path the spec describes.
      if (!state.activeSnapshot) {
        throw new Error('activeSnapshot is required to activate a workflow');
      }
      activeSnapshot = state.activeSnapshot;
      active = true;
    } else if (state.active === false) {
      // Deactivation keeps the last frozen snapshot for reference but stops
      // every background run (the run endpoints check `active`).
      active = false;
    }

    const updated: Workflow = {
      ...existing,
      active,
      activeSnapshot,
      liveBrowser:
        typeof state.liveBrowser === 'boolean' ? state.liveBrowser : existing.liveBrowser,
      updatedAt: nowIso(),
    };
    await this.repo.save(updated);
    return updated;
  }

  /**
   * Build the frozen snapshot for activation from the CURRENT design. Pure: no
   * storage write. The route validates the steps before calling this.
   */
  static buildActiveSnapshot(wf: Workflow): WorkflowActiveSnapshot {
    return {
      version: wf.version,
      name: wf.name,
      description: wf.description,
      steps: wf.steps,
      headless: wf.headless,
      webhookUrl: wf.webhookUrl,
      profileId: wf.profileId,
      activatedAt: nowIso(),
    };
  }

  /**
   * Explicit, user-requested snapshot of the current design. It is a version
   * like any other (version number is the next one, the design is untouched),
   * but tagged `manual` so it is never confused with autosave history and
   * never trimmed by WORKFLOW_MAX_VERSIONS.
   */
  async saveManual(userId: string, workflowId: string, label?: string | null): Promise<WorkflowVersionSnapshot | null> {
    const wf = await this.get(userId, workflowId);
    if (!wf) return null;
    const cleanLabel = typeof label === 'string' && label.trim()
      ? label.trim().slice(0, MAX_LABEL_LENGTH)
      : null;
    // Manual entries live in their own number range (MANUAL_VERSION_BASE + n),
    // so they never overwrite an autosave entry that shares the design version
    // number. Autosave numbers stay far below the base and are never affected.
    const existing = await this.repo.listVersions(userId, workflowId);
    const manualNumbers = existing
      .filter((s) => s.kind === 'manual' && typeof s.version === 'number')
      .map((s) => s.version);
    const next = manualNumbers.length
      ? Math.max(...manualNumbers) + 1
      : MANUAL_VERSION_BASE + 1;
    const snap: WorkflowVersionSnapshot = {
      ...WorkflowService.toSnapshot(wf),
      version: next,
      designVersion: wf.version,
      kind: 'manual',
      label: cleanLabel,
      savedAt: nowIso(),
    };
    await this.repo.saveVersion(userId, workflowId, snap);
    return snap;
  }

  /**
   * Restore a saved version into the editable design. The restored content
   * becomes the single current state (like an autosave edit): it bumps
   * `version` but writes NO history entry, and leaves the Workspace switches
   * and the frozen activation snapshot untouched. No version is deleted.
   */
  async restoreVersion(userId: string, workflowId: string, version: number): Promise<Workflow | null | 'not_found_version'> {
    const existing = await this.get(userId, workflowId);
    if (!existing) return null;
    const snap = await this.repo.getVersion(userId, workflowId, version);
    if (!snap) return 'not_found_version';
    const updated: Workflow = {
      ...existing,
      name: snap.name,
      description: snap.description ?? undefined,
      steps: snap.steps,
      headless: snap.headless ?? undefined,
      webhookUrl: snap.webhookUrl ?? undefined,
      profileId: snap.profileId ?? existing.profileId,
      version: existing.version + 1,
      updatedAt: nowIso(),
      active: existing.active,
      liveBrowser: existing.liveBrowser,
      activeSnapshot: existing.activeSnapshot ?? null,
    };
    await this.repo.save(updated);
    return updated;
  }

  // Delete a workflow and its entire version history. Returns true if it existed.
  async remove(userId: string, workflowId: string): Promise<boolean> {
    return this.repo.delete(userId, workflowId);
  }

  // List the version history of a workflow (newest version first).
  async listVersions(
    userId: string,
    workflowId: string
  ): Promise<WorkflowVersionSnapshot[]> {
    return this.repo.listVersions(userId, workflowId);
  }
}

function isRepository(x: unknown): x is WorkflowRepository {
  return !!x && typeof x === 'object'
    && typeof (x as WorkflowRepository).saveVersion === 'function'
    && typeof (x as WorkflowRepository).trimVersions === 'function';
}
