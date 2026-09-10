import { afterEach, expect, test } from "bun:test";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";

const bridgePath = fileURLToPath(new URL("../scripts/stdio-bridge.mjs", import.meta.url));
const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<Server>();
const bridgeEnv = {
  ...process.env,
  BLOCKBENCH_BRIDGE_STARTUP_TIMEOUT_MS: "1000",
  BLOCKBENCH_BRIDGE_HEALTH_INTERVAL_MS: "100",
  BLOCKBENCH_BRIDGE_HEALTH_TIMEOUT_MS: "300",
  BLOCKBENCH_BRIDGE_PARENT_INTERVAL_MS: "100",
  BLOCKBENCH_BRIDGE_SHUTDOWN_TIMEOUT_MS: "300",
};

async function bounded<T>(promise: Promise<T>, timeout = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Child process did not complete in time.")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await bounded(once(child, "exit"));
    }
  }
  children.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
});

async function fixture(options: { hangDelete?: boolean; hangHealth?: boolean; hangInitialize?: boolean } = {}) {
  const deleted: string[] = [];
  const requests: Array<{ body: Record<string, any>; session?: string; version?: string }> = [];
  const sessions = new Set<string>();
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/health")) {
      if (!options.hangHealth) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ status: "ok" }));
      }
      return;
    }
    const session = request.headers["mcp-session-id"] as string | undefined;
    if (request.method === "DELETE") {
      if (session) deleted.push(session);
      if (options.hangDelete) return;
      sessions.delete(session!);
      response.writeHead(200).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    requests.push({ body, session, version: request.headers["mcp-protocol-version"] as string | undefined });
    if (body.method === "initialize") {
      if (options.hangInitialize) return;
      const id = randomUUID();
      sessions.add(id);
      response.writeHead(200, { "content-type": "application/json", "mcp-session-id": id });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" },
      } }));
    } else if (body.id === undefined) {
      response.writeHead(202).end();
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } }));
    }
  });
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture address.");
  return { url: `http://127.0.0.1:${address.port}/bb-mcp`, server, requests, sessions, deleted };
}

function observe(child: ChildProcessWithoutNullStreams) {
  children.add(child);
  let buffer = "";
  let stderr = "";
  const messages: Array<Record<string, any>> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      messages.push(JSON.parse(buffer.slice(0, newline)));
      buffer = buffer.slice(newline + 1);
      child.emit("message-received");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => stderr += chunk);
  const exited = once(child, "exit");
  async function waitMessage(id: string | number) {
    return bounded((async () => {
      while (!messages.some((message) => message.id === id)) {
        await Promise.race([
          once(child, "message-received"),
          exited.then(() => { throw new Error(`Bridge exited: ${stderr}`); }),
        ]);
      }
      return messages.find((message) => message.id === id)!;
    })());
  }
  function send(message: object) { child.stdin.write(`${JSON.stringify(message)}\n`); }
  async function initialize(name = "bridge-test") {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name, version: "1" },
    } });
    await waitMessage(1);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }
  return { child, exited, initialize, send, waitMessage, stderr: () => stderr };
}

function launch(url: string) {
  return observe(spawn("node", [bridgePath, url], { env: bridgeEnv, windowsHide: true }));
}

test("forwards initialization, IDs and protocol version; EOF deletes the session and exits", async () => {
  const remote = await fixture();
  const bridge = launch(remote.url);
  await bridge.initialize("original-client");
  bridge.send({ jsonrpc: "2.0", id: "tool-list", method: "tools/list" });
  expect((await bridge.waitMessage("tool-list")).result).toEqual({ tools: [] });
  expect(remote.requests[0].body.params.clientInfo.name).toBe("original-client");
  const toolsRequest = remote.requests.find((request) => request.body.method === "tools/list")!;
  expect(toolsRequest.version).toBe("2025-11-25");
  expect(remote.sessions.has(toolsRequest.session!)).toBe(true);
  bridge.child.stdin.end();
  expect((await bounded(bridge.exited))[0]).toBe(0);
  expect(remote.deleted).toEqual([toolsRequest.session!]);
  expect(remote.sessions.size).toBe(0);
  expect(bridge.stderr()).toBe("");
});

test("concurrent bridges own distinct sessions and one can close independently", async () => {
  const remote = await fixture();
  const first = launch(remote.url);
  const second = launch(remote.url);
  await Promise.all([first.initialize("first"), second.initialize("second")]);
  expect(remote.sessions.size).toBe(2);
  first.child.stdin.end();
  await bounded(first.exited);
  expect(remote.sessions.size).toBe(1);
  second.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  expect((await second.waitMessage(2)).result.tools).toEqual([]);
  second.child.stdin.end();
  await bounded(second.exited);
  expect(remote.sessions.size).toBe(0);
});

test("EOF exits within the shutdown deadline even if session DELETE hangs", async () => {
  const remote = await fixture({ hangDelete: true });
  const bridge = launch(remote.url);
  await bridge.initialize();
  bridge.child.stdin.end();
  expect((await bounded(bridge.exited, 2000))[0]).toBe(0);
  expect(remote.deleted).toHaveLength(1);
});

test("a missing or unresponsive server cannot leave an initialized bridge alive", async () => {
  const remote = await fixture({ hangHealth: true });
  const bridge = launch(remote.url);
  await bridge.initialize();
  expect((await bounded(bridge.exited, 2500))[0]).toBe(1);
  expect(bridge.stderr()).toContain("unavailable");
  expect(remote.deleted).toHaveLength(1);
});

test("server shutdown closes an idle bridge with no further client input", async () => {
  const remote = await fixture();
  const bridge = launch(remote.url);
  await bridge.initialize();
  remote.server.closeAllConnections();
  await new Promise<void>((resolve) => remote.server.close(() => resolve()));
  servers.delete(remote.server);
  expect((await bounded(bridge.exited, 2500))[0]).toBe(1);
});

test("closing stdin before initialization exits without waiting for the startup deadline", async () => {
  const remote = await fixture();
  const bridge = launch(remote.url);
  bridge.child.stdin.end();
  expect((await bounded(bridge.exited, 2000))[0]).toBe(0);
  expect(remote.sessions.size).toBe(0);
});

test("initialization has a deadline even when the server accepts but never responds", async () => {
  const remote = await fixture({ hangInitialize: true });
  const bridge = launch(remote.url);
  bridge.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  expect((await bounded(bridge.exited, 2500))[0]).toBe(1);
  expect(bridge.stderr()).toContain("initialization timed out");
});

test("parent death closes the bridge even when its inherited stdin remains open", async () => {
  const remote = await fixture();
  // The grandchild inherits the test's input pipe. Holding that pipe open after
  // the intermediate parent exits distinguishes the parent watchdog from EOF.
  // Windows can forcibly close children with their inherited console. Only this
  // fixture detaches the grandchild to keep it alive for the watchdog test; the
  // bridge itself never spawns processes. The finally block owns its cleanup.
  const launcher = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit', windowsHide: true, detached: process.platform === 'win32',
    });
    process.stderr.write('BRIDGE_PID=' + child.pid + '\\n');
    process.on('message', () => process.exit(0));
    setInterval(() => {}, 1000);
  `;
  const parentProcess = spawn("node", ["-e", launcher, bridgePath, remote.url], {
    env: bridgeEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  const parent = observe(parentProcess as ChildProcessWithoutNullStreams);
  let bridgePid = 0;
  try {
    await parent.initialize();
    bridgePid = Number(parent.stderr().match(/BRIDGE_PID=(\d+)/)?.[1]);
    expect(bridgePid).toBeGreaterThan(0);
    // Ask only the intermediate parent to exit, leaving its child to clean up.
    parent.child.send("exit");
    await bounded(parent.exited);
    await bounded((async () => {
      for (;;) {
        // Verify the OS process using the same Node runtime as the bridge.
        const probe = spawn("node", ["-e", `
          try { process.kill(Number(process.argv[1]), 0); process.exitCode = 1; }
          catch (error) { if (error.code !== 'ESRCH') throw error; }
        `, String(bridgePid)], { windowsHide: true });
        children.add(probe);
        const [code] = await bounded(once(probe, "exit"));
        if (code === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })(), 2500);
    expect(remote.deleted).toHaveLength(1);
  } finally {
    bridgePid ||= Number(parent.stderr().match(/BRIDGE_PID=(\d+)/)?.[1]);
    if (bridgePid > 0) {
      try { process.kill(bridgePid, "SIGKILL"); } catch { /* already exited */ }
    }
  }
});

test.skipIf(process.platform === "win32")("SIGTERM deletes the session before exiting", async () => {
  const remote = await fixture();
  const bridge = launch(remote.url);
  await bridge.initialize();
  bridge.child.kill("SIGTERM");
  expect((await bounded(bridge.exited))[0]).toBe(143);
  expect(remote.deleted).toHaveLength(1);
});
