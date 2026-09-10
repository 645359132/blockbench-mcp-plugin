# Blockbench MCP Installation

This file helps AI assistants configure the Blockbench MCP server connection.

## Prerequisites

Before configuring the MCP connection, check the existing setup:

1. **Blockbench is running.**
   - The Blockbench desktop application must be open
   - The MCP plugin must be installed (File > Plugins > Load from URL: `https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js`)

2. **Read the server settings.**
   - Default: `http://127.0.0.1:3000/bb-mcp`
   - Use the configured port and endpoint if they differ from `:3000/bb-mcp`
   - Settings can be changed in Blockbench: Settings > General > MCP Server Port / MCP Server Endpoint

## Configuration

Prefer native Streamable HTTP. The server runs inside Blockbench, so HTTP clients need no Node.js helper process. Each independently initialized MCP connection receives its own default workspace. Agents sharing one connection must each choose a unique `workspace_id` and supply it on every tool call, beginning with `create_project`, or `select_project` to claim an unoccupied model. For resource listing/reading on a shared connection, pass `_meta: {"blockbench/workspace_id": "your-workspace"}`; if the client cannot attach metadata, use separate HTTP sessions.

### Codex

Add to `~/.codex/config.toml` or the project's `.codex/config.toml`:

```toml
[mcp_servers.blockbench]
url = "http://127.0.0.1:{PORT}/{ENDPOINT}"
```

See the [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp/).

### Cline

Add to `cline_mcp_settings.json`:
```json
{
  "mcpServers": {
    "blockbench": {
      "url": "http://127.0.0.1:{PORT}/{ENDPOINT}",
      "type": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### VS Code

Create `.vscode/mcp.json`:
```json
{
  "servers": {
    "blockbench": {
      "url": "http://127.0.0.1:{PORT}/{ENDPOINT}",
      "type": "http"
    }
  }
}
```

### Claude Code

```bash
claude mcp add blockbench --transport http http://127.0.0.1:{PORT}/{ENDPOINT}
```

### Antigravity

```json
{
  "mcpServers": {
    "blockbench": {
      "serverUrl": "http://127.0.0.1:{PORT}/{ENDPOINT}"
    }
  }
}
```

Replace `{PORT}` with the port number (default: `3000`) and `{ENDPOINT}` with the endpoint path (default: `bb-mcp`).

### Clients requiring stdio

Use native HTTP when supported. Otherwise, install Node.js 22 or newer, download this repository and run `bun install --frozen-lockfile` in it once. Keep its dependencies installed. For a local-command configuration such as `claude_desktop_config.json`, use:

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["/absolute/path/blockbench-mcp-plugin/scripts/stdio-bridge.mjs", "http://127.0.0.1:{PORT}/{ENDPOINT}"]
    }
  }
}
```

Windows paths can use forward slashes, for example `D:/tools/blockbench-mcp-plugin/scripts/stdio-bridge.mjs`. Use an absolute `node.exe` path if the client cannot resolve `node`.

This bridge launches no child processes. Its one Node.js process closes the MCP session and exits on stdin EOF/close, parent exit, supported termination signals, or a failed remote health check. Shutdown is bounded to two seconds. Initialization is bounded to 10 seconds; health is checked every 15 seconds with a five-second timeout. Force termination on Windows cannot run JavaScript cleanup, so server session expiry handles that case.

### Existing wrapper configurations

Replace `npx mcp-remote` and `cmd /c npx mcp-remote` configurations with the native HTTP examples, or with the single-process bridge for stdio-only clients. Restart the affected MCP connections. Old wrappers may require targeted cleanup after their originating client has closed; inspect their command lines and do not terminate unrelated Node.js processes.
