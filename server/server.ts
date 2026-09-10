/// <reference types="three" />
/// <reference types="blockbench-types" />
import { VERSION } from "@/lib/constants";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let serverInstance: McpServer | null = null;

/**
 * Creates a new MCP server instance using the official SDK
 */
export function createServer() {
  return new McpServer({
    name: "Blockbench MCP",
    version: VERSION,
  }, {
    instructions: "Each MCP session has its own modeling workspace. Start with create_project or list_projects then select_project. Agents sharing this connection must each choose a unique workspace_id and pass it on every tool call. Resource requests select a workspace with _meta['blockbench/workspace_id']. Tools and resources are serialized inside Blockbench and operate on the bound project. Global editor tools require explicit single-workspace opt-in. Use distinct export paths for each model.",
  });
}

/**
 * Gets the current server instance
 */
export function getServer() {
  if (!serverInstance) {
    serverInstance = createServer();
  }
  return serverInstance;
}

/**
 * Replaces the current server instance with a new one
 * @param newServer - The new server instance
 */
export function setServer(newServer: McpServer) {
  serverInstance = newServer;
}

// Export the default server instance
const server = getServer();
export default server;
