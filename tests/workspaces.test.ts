import { describe, expect, test } from "bun:test";
import { WorkspaceManager, type WorkspaceRequest } from "../lib/workspaces";

interface TestProject {
  uuid: string;
  elements: string[];
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const projects: TestProject[] = ["user", "a", "b", "c"].map((uuid) => ({ uuid, elements: [] }));
  let selected: TestProject | undefined = projects[0];
  let blockedProject: string | undefined;
  let editor = { camera: { x: 7 }, color: "user-color", time: 0 };
  const manager = new WorkspaceManager({
    getProjects: () => projects,
    getActiveProject: () => selected,
    selectProject: (project) => {
      if (project.uuid === blockedProject) return false;
      selected = project;
      return true;
    },
    unselectProject: () => { selected = undefined; },
    captureState: () => structuredClone(editor),
    restoreState: (state) => { editor = structuredClone(state) as typeof editor; },
  });
  manager.openSession("one");
  const bind = (sessionId: string, projectId: string, workspaceId?: string) => manager.run(
    { sessionId, workspaceId, requireProject: false },
    (context) => context.bindProject(projectId)
  );
  return {
    manager, projects, bind,
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
