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
  captureState?(): unknown;
  restoreState?(state: unknown): void | Promise<void>;
}

export interface WorkspaceScope {
  sessionId: string;
  workspaceId?: string;
}

export interface WorkspaceRequest extends WorkspaceScope {
  signal?: AbortSignal;
  requireProject?: boolean;
}

export interface WorkspaceContext {
  readonly sessionId: string;
  readonly workspaceId: string;
  getProjectId(): string | undefined;
  bindProject(uuid: string): void;
}

interface WorkspaceState {
  id: string;
  session: SessionState;
  projectId?: string;
  claimedProjects: Set<string>;
  hasEditorState: boolean;
  editorState?: unknown;
}

interface SessionState {
  id: string;
  closed: boolean;
  running: number;
  workspaces: Map<string, WorkspaceState>;
}

interface Invocation {
  workspace: WorkspaceState;
  context: WorkspaceContext;
}

function cancellationError(): Error {
  const error = new Error("The modeling operation was cancelled before it started.");
  error.name = "AbortError";
  return error;
}

/**
 * Blockbench's Project, Undo and editor globals form one execution domain.
 * Every tool and resource callback must use this queue, including reads.
 */
export class WorkspaceManager<ProjectType extends WorkspaceProject> {
  private readonly sessions = new Map<string, SessionState>();
  private readonly claims = new Map<string, WorkspaceState>();
  private queue: Promise<void> = Promise.resolve();
  private invocation?: Invocation;

  constructor(private readonly adapter: WorkspaceAdapter<ProjectType>) {}

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
      for (const uuid of workspace.claimedProjects) {
        if (this.claims.get(uuid) === workspace) this.claims.delete(uuid);
      }
    }
    session.workspaces.clear();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  private findWorkspace(scope?: WorkspaceScope): WorkspaceState {
    if (!scope) {
      if (!this.invocation) throw new Error("No modeling workspace is active.");
      return this.invocation.workspace;
    }
    const session = this.sessions.get(scope.sessionId);
    if (!session || session.closed) throw new Error("The modeling session is not open.");
    const workspace = session.workspaces.get(scope.workspaceId ?? "default");
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

  async run<Result>(
    request: WorkspaceRequest,
    operation: (context: WorkspaceContext) => Result | Promise<Result>
  ): Promise<Result> {
    const session = this.sessions.get(request.sessionId);
    if (!session || session.closed) {
      throw new Error("The modeling session is not open. Reconnect to the MCP server.");
    }
    if (request.signal?.aborted) throw cancellationError();
    const workspaceId = request.workspaceId ?? "default";
    if (!workspaceId.trim()) throw new Error("workspace_id must not be empty.");
    let workspace = session.workspaces.get(workspaceId);
    if (!workspace) {
      workspace = {
        id: workspaceId,
        session,
        claimedProjects: new Set(),
        hasEditorState: false,
      };
      session.workspaces.set(workspaceId, workspace);
    }
    const target = workspace;
    let started = false;
    let removeCancellationListener = (): void => {};
    const scheduled = this.queue.then(async () => {
      started = true;
      removeCancellationListener();
      if (request.signal?.aborted) throw cancellationError();
      // Keep the original session object: reconnecting must not revive old work.
      if (session.closed || this.sessions.get(session.id) !== session) {
        throw new Error("The modeling session closed before this operation started.");
      }
      return this.execute(target, request.requireProject ?? true, operation);
    });
    // Neither failures nor caller cancellation may poison or bypass the queue.
    this.queue = scheduled.then(() => {}, () => {});
    const signal = request.signal;
    if (!signal) return scheduled;

    return new Promise<Result>((resolve, reject) => {
      const cancel = (): void => {
        if (!started) reject(cancellationError());
      };
      signal.addEventListener("abort", cancel, { once: true });
      removeCancellationListener = () => signal.removeEventListener("abort", cancel);
      scheduled.then(resolve, reject);
      if (signal.aborted) cancel();
    });
  }

  private async execute<Result>(
    workspace: WorkspaceState,
    requireProject: boolean,
    operation: (context: WorkspaceContext) => Result | Promise<Result>
  ): Promise<Result> {
    if (requireProject && !workspace.projectId) {
      throw new Error("This workspace has no project. Call create_project or select_project first, using the same workspace_id on every call.");
    }
    const target = workspace.projectId
      ? this.adapter.getProjects().find((project) => project.uuid === workspace.projectId)
      : undefined;
    if (requireProject && !target) {
      throw new Error("This workspace's project is no longer open. Call create_project or select_project first.");
    }

    const previousProject = this.adapter.getActiveProject();
    const previousState = this.adapter.captureState?.();
    if (!workspace.hasEditorState && this.adapter.captureState) {
      workspace.editorState = this.adapter.captureState();
      workspace.hasEditorState = true;
    }
    const invocation: Invocation = {
      workspace,
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
      },
    };
    this.invocation = invocation;
    workspace.session.running++;
    let beganOperation = false;
    let result: Result | undefined;
    let failure: unknown;
    let failed = false;
    try {
      if (target) {
        this.selectProject(target);
      } else {
        // Bootstrap/list calls must not observe another caller's active project.
        const currentProject = this.adapter.getActiveProject();
        if (currentProject) this.adapter.unselectProject(currentProject);
      }
      if (workspace.hasEditorState) await this.adapter.restoreState?.(workspace.editorState);
      // Allow Blockbench's select-project Vue callbacks to finish before editing.
      await Promise.resolve();
      if (workspace.session.closed) throw new Error("The modeling session has closed.");
      beganOperation = true;
      result = await operation(invocation.context);
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        if (beganOperation && this.adapter.captureState) {
          workspace.editorState = this.adapter.captureState();
          workspace.hasEditorState = true;
        }
      } catch (error) {
        failure = failed ? new AggregateError([failure, error], "Operation and editor state capture failed.") : error;
        failed = true;
      }
      try {
        if (previousProject && this.adapter.getProjects().includes(previousProject)) {
          this.selectProject(previousProject);
        } else {
          const currentProject = this.adapter.getActiveProject();
          if (currentProject) this.adapter.unselectProject(currentProject);
          this.adapter.restoreNoProject?.();
        }
        if (this.adapter.captureState) await this.adapter.restoreState?.(previousState);
        await Promise.resolve();
      } catch (error) {
        failure = failed ? new AggregateError([failure, error], "Operation and editor state restoration failed.") : error;
        failed = true;
      } finally {
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

  private selectProject(project: ProjectType): void {
    if (this.adapter.getActiveProject()?.uuid === project.uuid) return;
    if (!this.adapter.selectProject(project) || this.adapter.getActiveProject()?.uuid !== project.uuid) {
      throw new Error(`Could not activate project "${project.uuid}". Finish any locked editor operation and retry.`);
    }
  }
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
  captureState: captureEditorState,
  restoreState: restoreEditorState,
});
