import { captureEditorState, restoreEditorState } from "./editorState";

export interface WorkspaceProject {
  uuid: string;
}

/** Adapters must return detached snapshots from captureState. */
export interface WorkspaceAdapter<ProjectType extends WorkspaceProject> {
  getProjects(): ProjectType[];
  getActiveProject(): ProjectType | undefined;
  selectProject(project: ProjectType): boolean;
  unselectProject(project: ProjectType): void;
  restoreNoProject?(): void;
  /** Prevent tab switches and closing while an operation runs; returns the unlock function. */
  lockProject?(project: ProjectType): () => void;
  captureState?(): unknown;
  restoreState?(state: unknown, options?: RestoreStateOptions): void | Promise<void>;
}

export interface RestoreStateOptions {
  /** The user moved to another tab: restore only state that is not tied to a project's view. */
  projectChanged?: boolean;
}

export interface SchedulingOptions {
  /**
   * How long the last workspace's project stays active once the queue drains, so an agent's
   * next call needs no project switch. 0 returns the user's tab immediately.
   */
  idleRestoreMs?: number | (() => number);
  /** Operations one workspace may run in a row while other workspaces wait. */
  sliceOperations?: number;
  /** Time one workspace may keep the editor while other workspaces wait. */
  sliceMs?: number;
}

export interface WorkspaceScope {
  sessionId: string;
  workspaceId?: string;
}

export interface WorkspaceRequest extends WorkspaceScope {
  signal?: AbortSignal;
  requireProject?: boolean;
  /**
   * Reject calls that omit workspace_id once the session hosts named workspaces.
   * Without this, an agent that forgets its ID silently edits the default workspace's model.
   */
  requireExplicitWorkspace?: boolean;
  /** The operation may activate another project itself (create_project), so the bound one is not locked. */
  allowProjectSwitch?: boolean;
  /**
   * False for operations that only read or change workspace bindings. They keep their place in
   * the workspace's order but never switch projects.
   */
  usesEditor?: boolean;
  /** Reject the call if it has not started after this long, instead of waiting indefinitely. */
  queueTimeoutMs?: number;
  /** Shown to queued callers while this operation holds the editor. */
  label?: string;
}

export interface WorkspaceContext {
  readonly sessionId: string;
  readonly workspaceId: string;
  getProjectId(): string | undefined;
  bindProject(uuid: string): void;
  /** True when this workspace created or selected the project and still owns it. */
  ownsProject(uuid: string): boolean;
  /** Give up ownership, e.g. after closing the project; unbinds the workspace if it was bound to it. */
  releaseProject(uuid: string): void;
}

interface WorkspaceState {
  id: string;
  session: SessionState;
  projectId?: string;
  claimedProjects: Set<string>;
  hasEditorState: boolean;
  editorState?: unknown;
  queue: QueueEntry[];
}

interface SessionState {
  id: string;
  closed: boolean;
  running: number;
  workspaces: Map<string, WorkspaceState>;
}

interface QueueEntry {
  workspace: WorkspaceState;
  /** Arrival position across all workspaces. */
  order: number;
  usesEditor: boolean;
  /** Runs the operation and settles its caller; never rejects. */
  start(): Promise<void>;
}

interface Invocation {
  workspace: WorkspaceState;
  context: WorkspaceContext;
  label?: string;
  startedAt: number;
}

/** What the user had open before a run of queued operations began. */
interface Baseline<ProjectType> {
  project?: ProjectType;
  state: unknown;
}

type Outcome<Result> = { ok: true; value: Result } | { ok: false; error: unknown };

const DEFAULT_WORKSPACE = "default";
const DEFAULT_SLICE_OPERATIONS = 32;
const DEFAULT_SLICE_MS = 1000;
const DEFAULT_IDLE_RESTORE_MS = 3000;

function cancellationError(): Error {
  const error = new Error("The modeling operation was cancelled before it started.");
  error.name = "AbortError";
  return error;
}

/**
 * Blockbench's Project, Undo and editor globals form one execution domain.
 * Every tool and resource callback must use this scheduler, including reads.
 *
 * One operation runs at a time. Each workspace's calls keep their order, but the
 * workspace holding the editor is served first for a bounded slice, because every
 * change of workspace costs a project switch and an editor state restore. The
 * user's project and editor state return once the editor has stayed idle.
 */
export class WorkspaceManager<ProjectType extends WorkspaceProject> {
  private readonly sessions = new Map<string, SessionState>();
  private readonly claims = new Map<string, WorkspaceState>();
  /** Workspaces with queued operations. */
  private readonly waiting = new Set<WorkspaceState>();
  private arrivals = 0;
  /** Queued and running operations. */
  private pending = 0;
  private draining = false;
  /** Use of the editor by the live workspace since it last changed. */
  private slice = { operations: 0, startedAt: 0 };
  private invocation?: Invocation;
  private baseline?: Baseline<ProjectType>;
  /** Workspace whose editor state is applied: undefined means the baseline's, null means unknown. */
  private liveWorkspace?: WorkspaceState | null;
  /** Project the last operation left active; a different one means the user changed tabs. */
  private parkedProjectId?: string;
  /** The editor sat idle with a workspace's project active, where the user could reach it. */
  private idled = false;
  private restoreTimer?: ReturnType<typeof setTimeout>;
  private restoreDue = false;

  constructor(
    private readonly adapter: WorkspaceAdapter<ProjectType>,
    private readonly scheduling: SchedulingOptions = {}
  ) {}

  get activeContext(): WorkspaceContext | undefined {
    return this.invocation?.context;
  }

  openSession(sessionId: string): void {
    if (!sessionId) throw new Error("A session ID is required.");
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (existing.closed) throw new Error("This modeling session is still closing.");
      return;
    }
    this.sessions.set(sessionId, {
      id: sessionId,
      closed: false,
      running: 0,
      workspaces: new Map(),
    });
  }

  /** Disconnecting releases ownership; it never closes or discards a model. */
  closeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.closed = true;
    if (session.running === 0) this.releaseSession(session);
  }

  private releaseSession(session: SessionState): void {
    for (const workspace of session.workspaces.values()) {
      if (this.liveWorkspace === workspace) this.liveWorkspace = null;
      for (const uuid of workspace.claimedProjects) {
        if (this.claims.get(uuid) === workspace) this.claims.delete(uuid);
      }
    }
    session.workspaces.clear();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    // Nobody is left to benefit from keeping a workspace's project active.
    if (this.sessions.size === 0 && this.restoreTimer !== undefined) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
      this.restoreDue = true;
      void this.drain();
    }
  }

  private findWorkspace(scope?: WorkspaceScope): WorkspaceState {
    if (!scope) {
      if (!this.invocation) throw new Error("No modeling workspace is active.");
      return this.invocation.workspace;
    }
    const session = this.sessions.get(scope.sessionId);
    if (!session || session.closed) throw new Error("The modeling session is not open.");
    const workspace = session.workspaces.get(scope.workspaceId ?? DEFAULT_WORKSPACE);
    if (!workspace) throw new Error("The modeling workspace has not been initialized.");
    return workspace;
  }

  getProjectId(scope?: WorkspaceScope): string | undefined {
    return this.findWorkspace(scope).projectId;
  }

  /** Show this workspace's projects and projects available for explicit binding. */
  getProjects(scope?: WorkspaceScope): ProjectType[] {
    if (!scope && !this.invocation) return this.adapter.getProjects();
    const workspace = this.findWorkspace(scope);
    return this.adapter.getProjects().filter((project) => {
      const owner = this.claims.get(project.uuid);
      return !owner || owner === workspace;
    });
  }

  assertProjectAccess(uuid: string): void {
    const workspace = this.invocation?.workspace;
    const owner = this.claims.get(uuid);
    if (workspace && owner && owner !== workspace) {
      throw new Error("This project belongs to another modeling workspace. Create or select an available project.");
    }
    if (!this.adapter.getProjects().some((project) => project.uuid === uuid)) {
      throw new Error(`Project "${uuid}" is no longer open. Create or select another project.`);
    }
  }

  bindProject(uuid: string): void {
    const workspace = this.findWorkspace();
    if (workspace.session.closed) throw new Error("The modeling session has closed.");
    this.assertProjectAccess(uuid);
    this.claims.set(uuid, workspace);
    workspace.claimedProjects.add(uuid);
    workspace.projectId = uuid;
  }

  releaseProject(uuid: string): void {
    const workspace = this.findWorkspace();
    if (this.claims.get(uuid) !== workspace) {
      throw new Error("Only projects owned by this workspace can be released.");
    }
    this.claims.delete(uuid);
    workspace.claimedProjects.delete(uuid);
    if (workspace.projectId === uuid) workspace.projectId = undefined;
  }

  /** Global UI/eval tools cannot share an editor with another active owner. */
  assertExclusive(): void {
    const current = this.findWorkspace();
    for (const session of this.sessions.values()) {
      if (session !== current.session && (!session.closed || session.running > 0)) {
        throw new Error("This tool requires an exclusive MCP session. Other modeling sessions are open.");
      }
      for (const workspace of session.workspaces.values()) {
        if (workspace !== current && workspace.claimedProjects.size > 0) {
          throw new Error("This tool requires an exclusive modeling workspace. Other workspaces own projects.");
        }
      }
    }
  }

  private resolveWorkspaceId(session: SessionState, request: WorkspaceRequest): string {
    if (request.workspaceId !== undefined) {
      if (!request.workspaceId.trim()) throw new Error("workspace_id must not be empty.");
      return request.workspaceId;
    }
    if (request.requireExplicitWorkspace) {
      const named = [...session.workspaces.keys()].filter((id) => id !== DEFAULT_WORKSPACE);
      if (named.length > 0) {
        throw new Error(
          `This MCP connection is shared by several workspaces (${named.join(", ")}). ` +
          `Pass your own workspace_id on every call; pass "${DEFAULT_WORKSPACE}" explicitly only if that workspace is yours.`
        );
      }
    }
    return DEFAULT_WORKSPACE;
  }

  private busyError(): Error {
    const current = this.invocation;
    const holder = current
      ? `"${current.label ?? "an operation"}" has held the editor for ${Math.round((Date.now() - current.startedAt) / 1000)}s`
      : "the editor is restoring the user's project";
    const error = new Error(
      `Blockbench is busy: ${holder}, with ${Math.max(this.pending - 1, 0)} operation(s) queued. ` +
      "A permission prompt or dialog in Blockbench may be waiting for the user. Retry later."
    );
    error.name = "TimeoutError";
    return error;
  }

  async run<Result>(
    request: WorkspaceRequest,
    operation: (context: WorkspaceContext) => Result | Promise<Result>
  ): Promise<Result> {
    const session = this.sessions.get(request.sessionId);
    if (!session || session.closed) {
      throw new Error("The modeling session is not open. Reconnect to the MCP server.");
    }
    if (request.signal?.aborted) throw cancellationError();
    const workspaceId = this.resolveWorkspaceId(session, request);
    let workspace = session.workspaces.get(workspaceId);
    if (!workspace) {
      workspace = {
        id: workspaceId,
        session,
        claimedProjects: new Set(),
        hasEditorState: false,
        queue: [],
      };
      session.workspaces.set(workspaceId, workspace);
    }
    const target = workspace;
    const signal = request.signal;
    const timeoutMs = request.queueTimeoutMs;

    return new Promise<Result>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stopWaiting = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      const entry: QueueEntry = {
        workspace: target,
        order: this.arrivals++,
        usesEditor: request.usesEditor ?? true,
        start: async () => {
          stopWaiting();
          let outcome: Outcome<Result>;
          try {
            if (signal?.aborted) throw cancellationError();
            // Keep the original session object: reconnecting must not revive old work.
            if (session.closed || this.sessions.get(session.id) !== session) {
              throw new Error("The modeling session closed before this operation started.");
            }
            outcome = { ok: true, value: await this.execute(target, request, operation) };
          } catch (error) {
            outcome = { ok: false, error };
          }
          this.pending--;
          if (this.pending === 0) {
            if (this.idleRestoreDelay() > 0) {
              this.deferRestore();
            } else {
              try {
                await this.restoreBaseline();
              } catch (error) {
                outcome = outcome.ok
                  ? { ok: false, error }
                  : { ok: false, error: new AggregateError([outcome.error, error], "Operation and editor state restoration failed.") };
              }
            }
          }
          if (outcome.ok) resolve(outcome.value);
          else reject(outcome.error);
        },
      };
      // A caller that stops waiting leaves the queue, so its operation can never run.
      const giveUp = (error: Error): void => {
        if (!this.abandon(entry)) return;
        stopWaiting();
        reject(error);
      };
      const cancel = (): void => giveUp(cancellationError());
      if (timeoutMs) timer = setTimeout(() => giveUp(this.busyError()), timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
      this.enqueue(entry);
    });
  }

  private enqueue(entry: QueueEntry): void {
    if (this.restoreTimer !== undefined) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = undefined;
    }
    this.restoreDue = false;
    // The workspace still holding the editor starts each busy period with a full slice.
    if (this.pending === 0) this.slice = { operations: 0, startedAt: Date.now() };
    this.pending++;
    entry.workspace.queue.push(entry);
    this.waiting.add(entry.workspace);
    void this.drain();
  }

  /** Returns false once the entry has started. */
  private abandon(entry: QueueEntry): boolean {
    const queue = entry.workspace.queue;
    const index = queue.indexOf(entry);
    if (index < 0) return false;
    queue.splice(index, 1);
    if (queue.length === 0) this.waiting.delete(entry.workspace);
    this.pending--;
    // Its arrival cancelled a pending restore that nothing else would reschedule.
    if (this.pending === 0 && this.baseline) this.deferRestore();
    return true;
  }

  /**
   * Stay on the workspace that holds the editor while its slice lasts, otherwise serve the
   * longest waiter. A call is overtaken by at most one slice per change of workspace.
   */
  private takeNext(): QueueEntry | undefined {
    let chosen: WorkspaceState | undefined;
    for (const workspace of this.waiting) {
      if (!chosen || workspace.queue[0].order < chosen.queue[0].order) chosen = workspace;
    }
    if (!chosen) return undefined;
    const live = this.liveWorkspace;
    const sliceOperations = this.scheduling.sliceOperations ?? DEFAULT_SLICE_OPERATIONS;
    const sliceMs = this.scheduling.sliceMs ?? DEFAULT_SLICE_MS;
    if (
      live && live !== chosen && live.queue.length > 0
      && this.slice.operations < sliceOperations && Date.now() - this.slice.startedAt < sliceMs
    ) {
      chosen = live;
    }
    const entry = chosen.queue.shift()!;
    if (chosen.queue.length === 0) this.waiting.delete(chosen);
    if (entry.usesEditor) {
      if (chosen === live) this.slice.operations++;
      else this.slice = { operations: 1, startedAt: Date.now() };
    }
    return entry;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    // run() only schedules: the editor is never touched in the caller's own turn.
    await Promise.resolve();
    try {
      for (;;) {
        const entry = this.takeNext();
        if (entry) {
          await entry.start();
          continue;
        }
        if (!this.restoreDue) return;
        this.restoreDue = false;
        try {
          await this.restoreBaseline();
        } catch (error) {
          console.error("[MCP] Could not restore the editor after modeling operations:", error);
        }
      }
    } finally {
      this.draining = false;
    }
  }

  private idleRestoreDelay(): number {
    if (!this.baseline || this.sessions.size === 0) return 0;
    const option = this.scheduling.idleRestoreMs ?? 0;
    const delay = typeof option === "function" ? option() : option;
    return delay > 0 ? delay : 0;
  }

  /** Restore the user's editor through the queue once it has stayed idle. */
  private deferRestore(): void {
    this.idled = true;
    this.restoreTimer = setTimeout(() => {
      this.restoreTimer = undefined;
      this.restoreDue = true;
      void this.drain();
    }, this.idleRestoreDelay());
  }

  private isApplied(state: unknown): boolean {
    if (!this.adapter.captureState) return true;
    return JSON.stringify(this.adapter.captureState()) === JSON.stringify(state);
  }

  private async execute<Result>(
    workspace: WorkspaceState,
    request: WorkspaceRequest,
    operation: (context: WorkspaceContext) => Result | Promise<Result>
  ): Promise<Result> {
    const requireProject = request.requireProject ?? true;
    if (requireProject && !workspace.projectId) {
      throw new Error("This workspace has no project. Call create_project or select_project first, using the same workspace_id on every call.");
    }
    const target = workspace.projectId
      ? this.adapter.getProjects().find((project) => project.uuid === workspace.projectId)
      : undefined;
    if (requireProject && !target) {
      throw new Error("This workspace's project is no longer open. Call create_project or select_project first.");
    }

    const usesEditor = request.usesEditor ?? true;
    let restoreWorkspaceState = false;
    if (usesEditor) {
      // A tab the user picked while the editor sat idle becomes their new starting point.
      if (this.baseline && this.adapter.getActiveProject()?.uuid !== this.parkedProjectId) {
        await this.restoreBaseline();
      }
      if (this.idled) {
        this.idled = false;
        // The user may have moved the camera or changed tools on the workspace's tab meanwhile.
        if (this.liveWorkspace && !this.isApplied(this.liveWorkspace.editorState)) this.liveWorkspace = null;
      }
      if (!this.baseline) {
        this.baseline = { project: this.adapter.getActiveProject(), state: this.adapter.captureState?.() };
        this.liveWorkspace = undefined;
      }
      // The baseline state is applied unless another workspace replaced it in this run.
      // Activating a different project replaces the view even for the live workspace.
      restoreWorkspaceState = this.liveWorkspace !== workspace
        ? workspace.hasEditorState || this.liveWorkspace !== undefined
        : target !== undefined && this.adapter.getActiveProject()?.uuid !== target.uuid;
      if (!workspace.hasEditorState && this.adapter.captureState) {
        workspace.editorState = this.baseline.state;
        workspace.hasEditorState = true;
      }
    }
    const invocation: Invocation = {
      workspace,
      label: request.label,
      startedAt: Date.now(),
      context: {
        sessionId: workspace.session.id,
        workspaceId: workspace.id,
        getProjectId: () => workspace.projectId,
        bindProject: (uuid) => {
          if (this.invocation !== invocation) {
            throw new Error("This modeling operation has already finished.");
          }
          this.bindProject(uuid);
        },
        ownsProject: (uuid) => this.claims.get(uuid) === workspace,
        releaseProject: (uuid) => {
          if (this.invocation !== invocation) {
            throw new Error("This modeling operation has already finished.");
          }
          this.releaseProject(uuid);
        },
      },
    };
    this.invocation = invocation;
    workspace.session.running++;
    let beganOperation = false;
    let unlock: (() => void) | undefined;
    let result: Result | undefined;
    let failure: unknown;
    let failed = false;
    try {
      if (usesEditor) {
        if (target) {
          this.selectProject(target);
          // Locked before any await: the user cannot switch or close the tab mid-operation.
          if (!request.allowProjectSwitch) unlock = this.adapter.lockProject?.(target);
        } else {
          // Bootstrap/list calls must not observe another caller's active project.
          const currentProject = this.adapter.getActiveProject();
          if (currentProject) this.adapter.unselectProject(currentProject);
        }
        if (restoreWorkspaceState) {
          // A partial restore must not be mistaken for any known state.
          this.liveWorkspace = null;
          await this.adapter.restoreState?.(workspace.editorState);
        }
        this.liveWorkspace = workspace;
        // Allow Blockbench's select-project Vue callbacks to finish before editing.
        await Promise.resolve();
      }
      if (workspace.session.closed) throw new Error("The modeling session has closed.");
      beganOperation = true;
      result = await operation(invocation.context);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        unlock?.();
      } catch (error) {
        failure = failed ? new AggregateError([failure, error], "Operation and project unlock failed.") : error;
        failed = true;
      }
      try {
        if (usesEditor && beganOperation && this.adapter.captureState) {
          workspace.editorState = this.adapter.captureState();
          workspace.hasEditorState = true;
        }
      } catch (error) {
        failure = failed ? new AggregateError([failure, error], "Operation and editor state capture failed.") : error;
        failed = true;
      } finally {
        if (usesEditor) this.parkedProjectId = this.adapter.getActiveProject()?.uuid;
        this.invocation = undefined;
        workspace.session.running--;
        if (workspace.session.closed && workspace.session.running === 0) {
          this.releaseSession(workspace.session);
        }
      }
    }
    if (failed) throw failure;
    return result as Result;
  }

  /** Return the editor to what the user had open once no queued work remains. */
  private async restoreBaseline(): Promise<void> {
    const baseline = this.baseline;
    if (!baseline) return;
    this.baseline = undefined;
    this.liveWorkspace = undefined;
    this.idled = false;
    // A tab the user picked while the editor sat idle is theirs to keep.
    const projectChanged = this.adapter.getActiveProject()?.uuid !== this.parkedProjectId;
    if (!projectChanged) {
      const previousProject = baseline.project;
      if (previousProject && this.adapter.getProjects().includes(previousProject)) {
        this.selectProject(previousProject);
      } else {
        const currentProject = this.adapter.getActiveProject();
        if (currentProject) this.adapter.unselectProject(currentProject);
        this.adapter.restoreNoProject?.();
      }
    }
    if (this.adapter.captureState) await this.adapter.restoreState?.(baseline.state, { projectChanged });
    await Promise.resolve();
  }

  private selectProject(project: ProjectType): void {
    if (this.adapter.getActiveProject()?.uuid === project.uuid) return;
    if (!this.adapter.selectProject(project) || this.adapter.getActiveProject()?.uuid !== project.uuid) {
      throw new Error(`Could not activate project "${project.uuid}". Finish any locked editor operation and retry.`);
    }
  }
}

/** Without Blockbench's settings (tests, documentation build) the user's tab returns immediately. */
function idleRestoreSetting(): number {
  if (typeof Settings === "undefined") return 0;
  const delay = Number(Settings.get("mcp_idle_restore_delay") ?? DEFAULT_IDLE_RESTORE_MS);
  return Number.isFinite(delay) ? delay : DEFAULT_IDLE_RESTORE_MS;
}

export const workspaceManager = new WorkspaceManager<ModelProject>({
  getProjects: () => ModelProject.all,
  getActiveProject: () => Project || undefined,
  selectProject: (project) => project.select() !== false,
  unselectProject: (project) => project.unselect(),
  restoreNoProject: () => {
    if (typeof Interface !== "undefined") {
      const editor = Interface as unknown as { tab_bar?: { openNewTab?: () => void } };
      editor.tab_bar?.openNewTab?.();
    }
  },
  // ModelProject.select(), close() and the new-tab button all refuse while Project.locked is set.
  lockProject: (project) => {
    const wasLocked = project.locked;
    project.locked = true;
    return () => { project.locked = wasLocked; };
  },
  captureState: captureEditorState,
  restoreState: restoreEditorState,
}, { idleRestoreMs: idleRestoreSetting });
