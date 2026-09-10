#!/usr/bin/env node
// Compatibility transport for clients that can only launch stdio MCP servers.
// HTTP-capable clients should connect to the plugin URL directly.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

function milliseconds(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 50 || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer between 50 and 2147483647 milliseconds.`);
  }
  return value;
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node /absolute/path/stdio-bridge.mjs http://127.0.0.1:3000/bb-mcp");
  }
  const endpoint = new URL(process.argv[2]);
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error("The MCP endpoint must be an HTTP or HTTPS URL.");
  }
  const startupTimeout = milliseconds("BLOCKBENCH_BRIDGE_STARTUP_TIMEOUT_MS", 10_000);
  const healthInterval = milliseconds("BLOCKBENCH_BRIDGE_HEALTH_INTERVAL_MS", 15_000);
  const healthTimeout = milliseconds("BLOCKBENCH_BRIDGE_HEALTH_TIMEOUT_MS", 5_000);
  const parentInterval = milliseconds("BLOCKBENCH_BRIDGE_PARENT_INTERVAL_MS", 1_000);
  const shutdownTimeout = milliseconds("BLOCKBENCH_BRIDGE_SHUTDOWN_TIMEOUT_MS", 2_000);
  const parentPid = process.ppid;
  const stdio = new StdioServerTransport();
  const remote = new StreamableHTTPClientTransport(endpoint);
  const healthUrl = new URL(endpoint);
  healthUrl.pathname = `${healthUrl.pathname.replace(/\/$/, "")}/health`;
  healthUrl.search = "";

  let stopping = false;
  let initializeId;
  let initialized = false;
  let healthTimer;
  let healthAbort;
  let parentTimer;
  let startupTimer;

  // DELETE may itself hang when Blockbench is exiting. The hard deadline also
  // covers SDK reconnect timers, open SSE streams, and blocked stdio writes.
  async function shutdown(code, reason) {
    if (stopping) return;
    stopping = true;
    if (reason) process.stderr.write(`[blockbench-mcp] ${reason}\n`);
    clearTimeout(startupTimer);
    clearTimeout(healthTimer);
    clearInterval(parentTimer);
    healthAbort?.abort();
    process.stdin.pause();
    const deadline = setTimeout(() => process.exit(code), shutdownTimeout);
    try {
      await remote.terminateSession();
    } catch {
      // The peer may already be gone; closing the local handles is still required.
    } finally {
      await Promise.allSettled([remote.close(), stdio.close()]);
      clearTimeout(deadline);
      process.exit(code);
    }
  }

  function fail(error) {
    void shutdown(1, error instanceof Error ? error.message : String(error));
  }

  async function checkHealth() {
    if (stopping) return;
    healthAbort = new AbortController();
    const timeout = setTimeout(() => healthAbort.abort(), healthTimeout);
    try {
      const response = await fetch(healthUrl, { signal: healthAbort.signal });
      if (!response.ok || (await response.json()).status !== "ok") {
        throw new Error("Blockbench MCP health check failed.");
      }
    } catch (error) {
      if (!stopping) fail(new Error("Blockbench MCP is unavailable; closing the stdio bridge.", { cause: error }));
    } finally {
      clearTimeout(timeout);
      if (!stopping) healthTimer = setTimeout(checkHealth, healthInterval);
    }
  }

  remote.onmessage = (message) => {
    if (stopping) return;
    if (!initialized && initializeId !== undefined && message.id === initializeId && 'result' in message) {
      const version = message.result.protocolVersion;
      if (typeof version === "string") {
        remote.setProtocolVersion(version);
        initialized = true;
        clearTimeout(startupTimer);
        healthTimer = setTimeout(checkHealth, healthInterval);
      }
    }
    void stdio.send(message).catch(fail);
  };
  stdio.onmessage = (message) => {
    if (stopping) return;
    if (message.method === "initialize") initializeId = message.id;
    void remote.send(message).catch(fail);
  };
  remote.onerror = fail;
  stdio.onerror = fail;
  remote.onclose = () => void shutdown(0);
  stdio.onclose = () => void shutdown(0);
  process.stdin.once("end", () => void shutdown(0));
  process.stdin.once("close", () => void shutdown(0));
  process.stdin.once("error", fail);
  process.stdout.once("error", fail);
  process.stdout.once("close", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));
  process.on("SIGHUP", () => void shutdown(129));
  process.once("uncaughtException", fail);
  process.once("unhandledRejection", fail);

  // On Windows ppid stays unchanged after the parent exits. On Unix it may be
  // reparented. Check both without launching a process or a shell.
  parentTimer = setInterval(() => {
    if (process.ppid !== parentPid || parentPid <= 1) {
      void shutdown(0);
      return;
    }
    try {
      process.kill(parentPid, 0);
    } catch (error) {
      if (error.code === "ESRCH") void shutdown(0);
    }
  }, parentInterval);
  startupTimer = setTimeout(() => fail(new Error("MCP initialization timed out.")), startupTimeout);
  await remote.start();
  if (!stopping) await stdio.start();
}

main().catch((error) => {
  process.stderr.write(`[blockbench-mcp] ${error.message}\n`);
  process.exit(1);
});
