import { afterAll, beforeAll, expect, test } from "bun:test";
import { z } from "zod";
import { createTool, createResource, registerToolsOnServer, registerResourcesOnServer, getAllToolDefinitions } from "../lib/factories";
import { workspaceManager } from "../lib/workspaces";
import { sessionManager } from "../lib/sessions";
import { registerProjectTools } from "../server/tools/project";
import type { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

interface TestProject { uuid: string; name: string; elements: string[]; select(): boolean; unselect(): void }
let active: TestProject | undefined;
const projects: TestProject[] = [];
const events: string[] = [];
type Extra = { sessionId: string; _meta?: Record<string, unknown> };
type Result = { content: Array<{ type: string; text: string }> };
const callbacks = new Map<string, (args: unknown, extra: Extra) => Promise<Result>>();
const reads = new Map<string, (uri: URL, variables: Record<string, string>, extra: Extra) => Promise<unknown>>();
const lists = new Map<string, ResourceTemplate>();
const originals = new Map<string, PropertyDescriptor | undefined>();
function install(name: string, descriptor: PropertyDescriptor): void {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, ...descriptor });
}
function call(name: string, sessionId: string, args: Record<string, unknown> = {}): Promise<Result> {
  return callbacks.get(name)!(args, { sessionId });
}

beforeAll(() => {
  install("Project", { get: () => active });
  install("ModelProject", { value: { all: projects } });
  install("Formats", { value: { bedrock_block: { id: "bedrock_block" } } });
  install("newProject", { value: () => {
    const project: TestProject = {
      uuid: crypto.randomUUID(), name: "", elements: [],
      select() { active = this; return true; },
      unselect() { active = undefined; },
    };
    projects.push(project);
    active = project;
    return true;
  } });
  if (!getAllToolDefinitions().create_project) registerProjectTools();
  createTool("test_model_edit", {
    description: "Asynchronous modeling operation for transport boundary tests",
    parameters: z.object({ label: z.string(), delay: z.number().default(0) }).refine(args => args.label !== "invalid", "Invalid edit"),
    async execute({ label, delay }) {
      const project = active!;
      events.push(`${label}:start`);
      await Bun.sleep(delay);
      expect(active).toBe(project);
      project.elements.push(label);
      events.push(`${label}:end`);
      return JSON.stringify({ uuid: project.uuid, elements: project.elements });
    },
  });
  createTool("risky_eval", {
    description: "Global operation must not execute in isolated mode",
    parameters: z.object({}),
    async execute() { throw new Error("UNSAFE TOOL RAN"); },
  });
  createResource("test_workspace_nodes", {
    description: "Project-scoped resource",
    uriTemplate: "test-workspace://{id}",
    async listCallback() {
      return { resources: active?.elements.map(name => ({ uri: `test-workspace://${name}`, name })) ?? [] };
    },
    async readCallback(uri) {
      return { contents: [{ uri: uri.href, text: JSON.stringify(active?.elements ?? []) }] };
    },
  });
  registerToolsOnServer({
    registerTool(name: string, _definition: unknown, callback: (args: unknown, extra: Extra) => Promise<Result>) { callbacks.set(name, callback); },
  });
  registerResourcesOnServer({
    registerResource(name: string, template: ResourceTemplate, _metadata: unknown, callback: typeof reads extends Map<string, infer R> ? R : never) {
      lists.set(name, template); reads.set(name, callback);
    },
  });
  sessionManager.configure({ pingIntervalMs: 0 });
  for (const id of ["factory-one", "factory-two", "factory-shared"]) {
    workspaceManager.openSession(id); sessionManager.add(id);
  }
});

afterAll(async () => {
  for (const id of ["factory-one", "factory-two", "factory-shared"]) workspaceManager.closeSession(id);
  await sessionManager.clear();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("factory forwards session identity and serializes complete modeling operations", async () => {
  await expect(call("test_model_edit", "factory-one", { label: "unbound" })).rejects.toThrow("no project");
  await Promise.all([
    call("create_project", "factory-one", { name: "first" }),
    call("create_project", "factory-two", { name: "second" }),
  ]);
  const [first, second] = await Promise.all([
    call("test_model_edit", "factory-one", { label: "first-cube", delay: 15 }),
    call("test_model_edit", "factory-two", { label: "second-cube" }),
  ]);
  expect(JSON.parse(first.content[0]!.text).uuid).not.toBe(JSON.parse(second.content[0]!.text).uuid);
  expect(events).toEqual(["first-cube:start", "first-cube:end", "second-cube:start", "second-cube:end"]);
  expect(projects.find(p => p.name === "first")?.elements).toEqual(["first-cube"]);
  expect(projects.find(p => p.name === "second")?.elements).toEqual(["second-cube"]);
  expect(active).toBeUndefined();
});

test("shared connection workspace_id routes every call and full schema refinements run", async () => {
  await call("create_project", "factory-shared", { name: "agent-a", workspace_id: "agent-a" });
  await call("create_project", "factory-shared", { name: "agent-b", workspace_id: "agent-b" });
  await Promise.all([
    call("test_model_edit", "factory-shared", { label: "a", workspace_id: "agent-a" }),
    call("test_model_edit", "factory-shared", { label: "b", workspace_id: "agent-b" }),
  ]);
  expect(projects.find(p => p.name === "agent-a")?.elements).toEqual(["a"]);
  expect(projects.find(p => p.name === "agent-b")?.elements).toEqual(["b"]);
  await expect(call("test_model_edit", "factory-shared", { label: "missing-id" })).rejects.toThrow("Pass your own workspace_id");
  await expect(call("test_model_edit", "factory-shared", { label: "invalid", workspace_id: "agent-a" })).rejects.toThrow("Invalid edit");
});

test("project claims, resource lists and reads use the same workspace boundary", async () => {
  const firstId = projects.find(p => p.name === "first")!.uuid;
  await expect(call("select_project", "factory-two", { project_id: firstId })).rejects.toThrow("another modeling workspace");
  const extra = { sessionId: "factory-shared", _meta: { "blockbench/workspace_id": "agent-b" } };
  const result = await reads.get("test_workspace_nodes")!(new URL("test-workspace://b"), { id: "b" }, extra);
  expect(result).toEqual({ contents: [{ uri: "test-workspace://b", text: '["b"]' }] });
  const listCallback = lists.get("test_workspace_nodes")!.listCallback!;
  const listed = await listCallback({
    ...extra,
    signal: new AbortController().signal,
    requestId: "resource-list-test",
    sendNotification: async () => {},
    sendRequest: async () => { throw new Error("Unexpected server request"); },
  });
  expect(listed.resources.map(item => item.name)).toEqual(["b"]);
  await expect(call("risky_eval", "factory-one")).rejects.toThrow("Global editor tools are disabled");
});
