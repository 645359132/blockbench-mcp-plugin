import { describe, expect, test } from "bun:test";
import { WorkspaceManager, type RestoreStateOptions, type SchedulingOptions, type WorkspaceRequest } from "../lib/workspaces";

interface TestProject {
  uuid: string;
  elements: string[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(scheduling?: SchedulingOptions) {
  const projects: TestProject[] = ["user", "a", "b", "c"].map((uuid) => ({ uuid, elements: [] }));
  let selected: TestProject | undefined = projects[0];
  let blockedProject: string | undefined;
  let editor = { camera: { x: 7 }, color: "user-color", time: 0 };
  const locked = new Set<string>();
  const selections: string[] = [];
  const restores: Array<RestoreStateOptions | undefined> = [];
  const manager = new WorkspaceManager({
    getProjects: () => projects,
    getActiveProject: () => selected,
    selectProject: (project) => {
      if (project.uuid === blockedProject) return false;
      // Mirrors ModelProject.select(): a locked tab cannot be left or entered.
      if (locked.has(project.uuid) || (selected && locked.has(selected.uuid))) return false;
      selected = project;
      selections.push(project.uuid);
      return true;
    },
    unselectProject: () => { selected = undefined; },
    lockProject: (project) => {
      locked.add(project.uuid);
      return () => { locked.delete(project.uuid); };
    },
    captureState: () => structuredClone(editor),
    restoreState: (state, options) => {
      restores.push(options);
      // Mirrors restoreEditorState(): the camera belongs to the tab the user moved to.
      const saved = structuredClone(state) as typeof editor;
      editor = options?.projectChanged ? { ...saved, camera: editor.camera } : saved;
    },
  }, scheduling);
  manager.openSession("one");
  const bind = (sessionId: string, projectId: string, workspaceId?: string) => manager.run(
    { sessionId, workspaceId, requireProject: false },
    (context) => context.bindProject(projectId)
  );
  return {
    manager, projects, bind, locked, selections, restores,
    select: (uuid: string) => {
      if (selected && locked.has(selected.uuid)) return false;
      selected = projects.find((candidate) => candidate.uuid === uuid);
      return true;
    },
    current: () => selected,
    editor: () => editor,
    clearSelection: () => { selected = undefined; },
    block: (uuid: string | undefined) => { blockedProject = uuid; },
  };
}

describe("workspace ownership and project selection", () => {
  test("uninitialized and unbound sessions never inherit the selected project", async () => {
    const { manager, current } = fixture();
    let called = false;
    await expect(manager.run({ sessionId: "unknown" }, () => { called = true; })).rejects.toThrow("not open");
    await expect(manager.run({ sessionId: "one" }, () => { called = true; })).rejects.toThrow("no project");
    expect(called).toBe(false);
    expect(current()?.uuid).toBe("user");
  });

  test("bootstrap calls run with no selected project and restore the user's tab", async () => {
    const { manager, current } = fixture();
    await manager.run({ sessionId: "one", requireProject: false }, () => {
      expect(current()).toBeUndefined();
      expect(manager.getProjectId()).toBeUndefined();
      expect(manager.getProjects().length).toBe(4);
    });
    expect(current()?.uuid).toBe("user");
  });

  test("local UI project inspection preserves its existing access outside an MCP operation", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    expect(manager.getProjects().map((project) => project.uuid)).toContain("a");
    expect(() => manager.assertProjectAccess("a")).not.toThrow();
    expect(() => manager.assertProjectAccess("missing")).toThrow("no longer open");
  });

  test("concurrent sessions run one complete async operation at a time", async () => {
    const { manager, current, projects, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const entered = deferred();
    const resume = deferred();
    const events: string[] = [];
    const first = manager.run({ sessionId: "one" }, async () => {
      events.push(`start:${current()?.uuid}`);
      entered.resolve();
      await resume.promise;
      current()!.elements.push("a-cube");
      events.push(`end:${current()?.uuid}`);
    });
    await entered.promise;
    const second = manager.run({ sessionId: "two" }, () => {
      events.push(`start:${current()?.uuid}`);
      current()!.elements.push("b-cube");
    });
    await Promise.resolve();
    expect(events).toEqual(["start:a"]);
    resume.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["start:a", "end:a", "start:b"]);
    expect(projects[1].elements).toEqual(["a-cube"]);
    expect(projects[2].elements).toEqual(["b-cube"]);
    expect(current()?.uuid).toBe("user");
  });

  test("explicit workspaces separate agents sharing the same MCP session", async () => {
    const { manager, current, projects, bind } = fixture();
    await bind("one", "a", "agent-a");
    await bind("one", "b", "agent-b");
    await Promise.all(["agent-a", "agent-b", "agent-a"].map((workspaceId) => manager.run(
      { sessionId: "one", workspaceId },
      () => current()!.elements.push(workspaceId)
    )));
    expect(projects[1].elements).toEqual(["agent-a", "agent-a"]);
    expect(projects[2].elements).toEqual(["agent-b"]);
    await expect(manager.run({ sessionId: "one" }, () => {})).rejects.toThrow("no project");
    await expect(bind("one", "a", "agent-b")).rejects.toThrow("another modeling workspace");
  });

  test("rebinding retains ownership of earlier projects and resource lists filter claims", async () => {
    const { manager, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("one", "c");
    const visible = await manager.run({ sessionId: "two", requireProject: false }, () =>
      manager.getProjects().map((project) => project.uuid)
    );
    expect(visible).toEqual(["user", "b"]);
    await expect(bind("two", "a")).rejects.toThrow("another modeling workspace");
    await expect(manager.run({ sessionId: "two", requireProject: false }, () =>
      manager.assertProjectAccess("c")
    )).rejects.toThrow("another modeling workspace");
  });

  test("closed projects and refused project switches fail before editing", async () => {
    const f = fixture();
    await f.bind("one", "a");
    f.block("a");
    let called = false;
    await expect(f.manager.run({ sessionId: "one" }, () => { called = true; })).rejects.toThrow("Could not activate");
    expect(f.current()?.uuid).toBe("user");
    f.block(undefined);
    f.projects.splice(1, 1);
    await expect(f.manager.run({ sessionId: "one" }, () => { called = true; })).rejects.toThrow("no longer open");
    expect(called).toBe(false);
    await f.bind("one", "b");
    expect(await f.manager.run({ sessionId: "one" }, () => f.current()?.uuid)).toBe("b");
  });

  test("restores the original selection after failure and leaves later calls usable", async () => {
    const { manager, current, bind } = fixture();
    await bind("one", "a");
    await expect(manager.run({ sessionId: "one" }, () => { throw new Error("operation failed"); })).rejects.toThrow("operation failed");
    expect(current()?.uuid).toBe("user");
    expect(manager.activeContext).toBeUndefined();
    expect(await manager.run({ sessionId: "one" }, () => current()?.uuid)).toBe("a");
    expect(current()?.uuid).toBe("user");
  });

  test("restores no selected project when the call started on the start screen", async () => {
    const { manager, current, clearSelection, bind } = fixture();
    clearSelection();
    await bind("one", "a");
    expect(await manager.run({ sessionId: "one" }, () => current()?.uuid)).toBe("a");
    expect(current()).toBeUndefined();
  });

  test("camera, paint and timeline snapshots remain private to each workspace", async () => {
    const { manager, editor, bind } = fixture();
    await bind("one", "a", "agent-a");
    await bind("one", "b", "agent-b");
    const forWorkspace = (workspaceId: string): WorkspaceRequest => ({ sessionId: "one", workspaceId });
    await manager.run(forWorkspace("agent-a"), () => {
      editor().camera.x = 10;
      editor().color = "red";
      editor().time = 4;
    });
    expect(editor()).toEqual({ camera: { x: 7 }, color: "user-color", time: 0 });
    await manager.run(forWorkspace("agent-b"), () => {
      expect(editor()).toEqual({ camera: { x: 7 }, color: "user-color", time: 0 });
      editor().camera.x = 20;
      editor().color = "blue";
    });
    await manager.run(forWorkspace("agent-a"), () => {
      expect(editor()).toEqual({ camera: { x: 10 }, color: "red", time: 4 });
    });
    expect(editor()).toEqual({ camera: { x: 7 }, color: "user-color", time: 0 });
  });
});

describe("session closure and cancellation", () => {
  test("disconnect holds claims until running work finishes and skips queued work", async () => {
    const { manager, current, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId: "one" }, async () => {
      entered.resolve();
      await resume.promise;
      expect(current()?.uuid).toBe("a");
    });
    await entered.promise;
    let queuedCalled = false;
    const queued = manager.run({ sessionId: "one" }, () => { queuedCalled = true; });
    const queuedFailure = queued.then(() => new Error("Unexpected success"), (error: Error) => error);
    manager.closeSession("one");
    expect(manager.getProjects({ sessionId: "two" }).map((project) => project.uuid)).not.toContain("a");
    await expect(manager.run({ sessionId: "one" }, () => {})).rejects.toThrow("not open");
    resume.resolve();
    await running;
    expect((await queuedFailure).message).toContain("closed before");
    expect(queuedCalled).toBe(false);
    expect(manager.getProjects({ sessionId: "two" }).map((project) => project.uuid)).toContain("a");
    await bind("two", "a");
  });

  test("a queued cancellation rejects promptly and never performs the operation", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId: "one" }, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    let called = false;
    const queued = manager.run({ sessionId: "one", signal: controller.signal }, () => { called = true; });
    controller.abort();
    await expect(queued).rejects.toThrow("cancelled before");
    expect(called).toBe(false);
    resume.resolve();
    await running;
    await manager.run({ sessionId: "one" }, () => {});
    expect(called).toBe(false);
  });

  test("cancelling a running operation does not release the editor to another agent", async () => {
    const { manager, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const controller = new AbortController();
    const entered = deferred();
    const resume = deferred();
    const events: string[] = [];
    const running = manager.run({ sessionId: "one", signal: controller.signal }, async () => {
      events.push("first-start");
      entered.resolve();
      await resume.promise;
      events.push("first-end");
    });
    await entered.promise;
    controller.abort();
    const next = manager.run({ sessionId: "two" }, () => { events.push("second"); });
    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    resume.resolve();
    await Promise.all([running, next]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  test("old queued work cannot be revived by reopening the same session ID", async () => {
    const { manager, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId: "two" }, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    let called = false;
    const queued = manager.run({ sessionId: "one" }, () => { called = true; });
    const queuedFailure = queued.then(() => new Error("Unexpected success"), (error: Error) => error);
    manager.closeSession("one");
    manager.openSession("one");
    resume.resolve();
    await running;
    expect((await queuedFailure).message).toContain("closed before");
    expect(called).toBe(false);
    await expect(manager.run({ sessionId: "one" }, () => {})).rejects.toThrow("no project");
  });

  test("unsafe global tools require one live session and one project-owning workspace", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => manager.assertExclusive());
    manager.openSession("two");
    await expect(manager.run({ sessionId: "one" }, () => manager.assertExclusive())).rejects.toThrow("exclusive MCP session");
    manager.closeSession("two");
    await bind("one", "b", "other-agent");
    await expect(manager.run({ sessionId: "one" }, () => manager.assertExclusive())).rejects.toThrow("exclusive modeling workspace");
  });
});

describe("shared editor scheduling", () => {
  test("the bound project is locked while an operation runs and unlocked afterwards", async () => {
    const { manager, bind, locked, select, current } = fixture();
    await bind("one", "a");
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId: "one" }, async () => {
      entered.resolve();
      await resume.promise;
      return current()?.uuid;
    });
    await entered.promise;
    expect([...locked]).toEqual(["a"]);
    // A user clicking another tab mid-operation is refused.
    expect(select("user")).toBe(false);
    resume.resolve();
    expect(await running).toBe("a");
    expect(locked.size).toBe(0);
    expect(current()?.uuid).toBe("user");
  });

  test("operations that create projects themselves are not locked", async () => {
    const { manager, bind, locked } = fixture();
    await bind("one", "a");
    await manager.run({ sessionId: "one", requireProject: false, allowProjectSwitch: true }, () => {
      expect(locked.size).toBe(0);
    });
  });

  test("queued work switches directly between projects and restores the user's tab once", async () => {
    // One-operation slices serve workspaces strictly in arrival order.
    const { manager, bind, selections, current, editor } = fixture({ sliceOperations: 1 });
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    selections.length = 0;
    const entered = deferred();
    const resume = deferred();
    const seen: unknown[] = [];
    const first = manager.run({ sessionId: "one" }, async () => {
      entered.resolve();
      await resume.promise;
      editor().color = "agent-a";
    });
    await entered.promise;
    const second = manager.run({ sessionId: "two" }, () => { seen.push(structuredClone(editor())); });
    const third = manager.run({ sessionId: "one" }, () => { seen.push(structuredClone(editor())); });
    resume.resolve();
    await Promise.all([first, second, third]);
    expect(selections).toEqual(["a", "b", "a", "user"]);
    // A workspace's first call starts from the user's editor state, not the previous agent's.
    expect(seen).toEqual([
      { camera: { x: 7 }, color: "user-color", time: 0 },
      { camera: { x: 7 }, color: "agent-a", time: 0 },
    ]);
    expect(current()?.uuid).toBe("user");
    expect(editor().color).toBe("user-color");
  });

  test("a queued call times out with the busy operation's name and never runs", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId: "one", label: "export_model" }, async () => {
      entered.resolve();
      await resume.promise;
    });
    await entered.promise;
    let called = false;
    const queued = manager.run({ sessionId: "one", queueTimeoutMs: 10 }, () => { called = true; });
    await expect(queued).rejects.toThrow('"export_model" has held the editor');
    resume.resolve();
    await running;
    await manager.run({ sessionId: "one" }, () => {});
    expect(called).toBe(false);
  });

  test("calls without workspace_id are refused once named workspaces share the session", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    const strict = { sessionId: "one", requireExplicitWorkspace: true };
    expect(await manager.run(strict, (context) => context.workspaceId)).toBe("default");
    await bind("one", "b", "agent-b");
    await expect(manager.run(strict, () => {})).rejects.toThrow("Pass your own workspace_id");
    expect(await manager.run({ ...strict, workspaceId: "default" }, (context) => context.getProjectId())).toBe("a");
    // Read-only resource requests keep the default fallback.
    expect(await manager.run({ sessionId: "one" }, (context) => context.workspaceId)).toBe("default");
  });
});

describe("workspace affinity", () => {
  /** Holds the editor with one running call for `sessionId` until `release()` is called. */
  async function occupy(manager: WorkspaceManager<TestProject>, sessionId: string, events: string[]) {
    const entered = deferred();
    const resume = deferred();
    const running = manager.run({ sessionId }, async () => {
      entered.resolve();
      await resume.promise;
      events.push(sessionId);
    });
    await entered.promise;
    return { running, release: resume.resolve };
  }

  test("interleaved calls are grouped by workspace instead of switching projects every call", async () => {
    const { manager, bind, selections, current } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    selections.length = 0;
    const events: string[] = [];
    const holder = await occupy(manager, "one", events);
    const queued = ["two", "one", "two", "one"].map((sessionId, index) =>
      manager.run({ sessionId }, () => { events.push(`${sessionId}:${index}`); })
    );
    holder.release();
    await Promise.all([holder.running, ...queued]);
    // Each workspace keeps its own order; only the order between workspaces changes.
    expect(events).toEqual(["one", "one:1", "one:3", "two:0", "two:2"]);
    expect(selections).toEqual(["a", "b", "user"]);
    expect(current()?.uuid).toBe("user");
  });

  test("a slice is bounded so a busy workspace cannot starve the others", async () => {
    const { manager, bind } = fixture({ sliceOperations: 2 });
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const events: string[] = [];
    const holder = await occupy(manager, "one", events);
    const queued = ["two", "one", "one", "one"].map((sessionId, index) =>
      manager.run({ sessionId }, () => { events.push(`${sessionId}:${index}`); })
    );
    holder.release();
    await Promise.all([holder.running, ...queued]);
    expect(events).toEqual(["one", "one:1", "two:0", "one:2", "one:3"]);
  });

  test("a slice also ends once its time is used up", async () => {
    const { manager, bind } = fixture({ sliceMs: 0 });
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    const events: string[] = [];
    const holder = await occupy(manager, "one", events);
    const queued = ["two", "one"].map((sessionId) => manager.run({ sessionId }, () => { events.push(`${sessionId}:queued`); }));
    holder.release();
    await Promise.all([holder.running, ...queued]);
    expect(events).toEqual(["one", "two:queued", "one:queued"]);
  });

  test("binding-only operations keep their order without activating any project", async () => {
    const { manager, selections, current, projects } = fixture();
    const order: string[] = [];
    const bound = manager.run({ sessionId: "one", requireProject: false, usesEditor: false }, (context) => {
      order.push("bind");
      expect(current()?.uuid).toBe("user");
      context.bindProject("a");
    });
    const edited = manager.run({ sessionId: "one" }, () => {
      order.push("edit");
      current()!.elements.push("cube");
    });
    await Promise.all([bound, edited]);
    expect(order).toEqual(["bind", "edit"]);
    expect(projects[1].elements).toEqual(["cube"]);
    expect(selections).toEqual(["a", "user"]);
  });

  test("a call that stops waiting leaves the queue and is not counted as queued work", async () => {
    const { manager, bind } = fixture();
    await bind("one", "a");
    const events: string[] = [];
    const holder = await occupy(manager, "one", events);
    const controller = new AbortController();
    const cancelled = manager.run({ sessionId: "one", signal: controller.signal }, () => { events.push("cancelled"); });
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled before");
    const waiting = manager.run({ sessionId: "one", queueTimeoutMs: 10 }, () => { events.push("timed-out"); });
    // Only the timed-out caller itself was still queued.
    await expect(waiting).rejects.toThrow("with 1 operation(s) queued");
    holder.release();
    await holder.running;
    expect(events).toEqual(["one"]);
  });
});

describe("deferred return to the user's tab", () => {
  const idleRestoreMs = 25;
  const idle = () => new Promise<void>((resolve) => setTimeout(resolve, idleRestoreMs * 3));

  test("sequential calls reuse the active project and the user's tab returns once the editor is idle", async () => {
    const { manager, bind, selections, current, editor } = fixture({ idleRestoreMs });
    await bind("one", "a");
    selections.length = 0;
    for (const color of ["red", "green", "blue"]) {
      await manager.run({ sessionId: "one" }, () => { editor().color = color; });
      expect(current()?.uuid).toBe("a");
    }
    expect(selections).toEqual(["a"]);
    await idle();
    expect(selections).toEqual(["a", "user"]);
    expect(editor()).toEqual({ camera: { x: 7 }, color: "user-color", time: 0 });
    // The next call starts a new run from the workspace's own state.
    expect(await manager.run({ sessionId: "one" }, () => editor().color)).toBe("blue");
  });

  test("a call arriving before the delay ends postpones the return", async () => {
    const { manager, bind, selections } = fixture({ idleRestoreMs });
    await bind("one", "a");
    selections.length = 0;
    await manager.run({ sessionId: "one" }, () => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await manager.run({ sessionId: "one" }, () => {});
    expect(selections).toEqual(["a"]);
    await idle();
    expect(selections).toEqual(["a", "user"]);
  });

  test("a tab the user picks while the editor is idle is kept", async () => {
    const { manager, bind, select, current, editor, restores } = fixture({ idleRestoreMs });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => { editor().color = "agent"; editor().camera.x = 1; });
    expect(select("c")).toBe(true);
    editor().camera.x = 50;
    await idle();
    expect(current()?.uuid).toBe("c");
    expect(restores.at(-1)).toEqual({ projectChanged: true });
    expect(editor()).toEqual({ camera: { x: 50 }, color: "user-color", time: 0 });
  });

  test("the picked tab becomes the user's tab for calls that follow", async () => {
    const { manager, bind, select, current, editor } = fixture({ idleRestoreMs });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => { editor().color = "agent"; });
    select("c");
    expect(await manager.run({ sessionId: "one" }, () => [current()?.uuid, editor().color])).toEqual(["a", "agent"]);
    await idle();
    expect(current()?.uuid).toBe("c");
    expect(editor().color).toBe("user-color");
  });

  test("editor changes the user makes on the workspace's tab do not leak into its next call", async () => {
    const { manager, bind, editor, restores } = fixture({ idleRestoreMs });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => { editor().camera.x = 10; });
    const untouched = restores.length;
    expect(await manager.run({ sessionId: "one" }, () => editor().camera.x)).toBe(10);
    // Nothing changed in between, so the state was not applied again.
    expect(restores.length).toBe(untouched);
    editor().camera.x = 99;
    expect(await manager.run({ sessionId: "one" }, () => editor().camera.x)).toBe(10);
  });

  test("rebinding a live workspace reapplies its state to the newly activated project", async () => {
    const { manager, bind, current, restores } = fixture({ idleRestoreMs });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => {});
    await manager.run({ sessionId: "one", requireProject: false, usesEditor: false }, (context) => context.bindProject("b"));
    const before = restores.length;
    expect(await manager.run({ sessionId: "one" }, () => current()?.uuid)).toBe("b");
    expect(restores.length).toBe(before + 1);
  });

  test("the user's tab returns at once when the last session disconnects", async () => {
    const { manager, bind, current } = fixture({ idleRestoreMs: 60_000 });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => {});
    expect(current()?.uuid).toBe("a");
    manager.closeSession("one");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(current()?.uuid).toBe("user");
  });

  test("a cancelled call still lets the user's tab return", async () => {
    const { manager, bind, current } = fixture({ idleRestoreMs });
    await bind("one", "a");
    await manager.run({ sessionId: "one" }, () => {});
    const controller = new AbortController();
    const cancelled = manager.run({ sessionId: "one", signal: controller.signal }, () => {});
    controller.abort();
    await expect(cancelled).rejects.toThrow("cancelled before");
    await idle();
    expect(current()?.uuid).toBe("user");
  });
});

describe("releasing projects", () => {
  test("a workspace releases only its own projects and becomes unbound", async () => {
    const { manager, bind } = fixture();
    manager.openSession("two");
    await bind("one", "a");
    await bind("two", "b");
    await expect(manager.run({ sessionId: "two", requireProject: false }, (context) => context.releaseProject("a")))
      .rejects.toThrow("Only projects owned by this workspace");
    const owned = await manager.run({ sessionId: "one", requireProject: false }, (context) => {
      const before = context.ownsProject("a");
      context.releaseProject("a");
      return [before, context.ownsProject("a"), context.getProjectId()];
    });
    expect(owned).toEqual([true, false, undefined]);
    await expect(manager.run({ sessionId: "one" }, () => {})).rejects.toThrow("no project");
    // Released projects can be claimed by other workspaces again.
    await bind("two", "a");
  });
});
