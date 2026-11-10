# Blockbench MCP

https://github.com/user-attachments/assets/ab1b7e63-b6f0-4d5b-85ab-79d328de31db

## Plugin Installation

Open the desktop version of Blockbench, go to File > Plugins and click the "Load Plugin from URL" and paste in this URL:

**[https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js](https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js)**

## Model Context Protocol Server

Configure the MCP server under Blockbench settings: **Settings** > **General** > **MCP Server Port** and **MCP Server Endpoint**

The following examples use the default values of `:3000/bb-mcp`

### Installation

Prefer the client's native **Streamable HTTP** connection. The MCP server runs inside Blockbench; a direct HTTP connection starts **zero extra Node.js processes**, including when several agents connect at once.

#### Codex

Add to `~/.codex/config.toml` (or the project's `.codex/config.toml`):

```toml
[mcp_servers.blockbench]
url = "http://127.0.0.1:3000/bb-mcp"
```

See the [official Codex MCP configuration documentation](https://developers.openai.com/codex/mcp/).

#### VS Code

**`.vscode/mcp.json`**

```json
{
  "servers": {
    "blockbench": {
      "url": "http://127.0.0.1:3000/bb-mcp",
      "type": "http"
    }
  }
}
```

#### Claude Code

```bash
claude mcp add blockbench --transport http http://127.0.0.1:3000/bb-mcp
```

#### [Antigravity](https://antigravity.google/docs/mcp#connecting-custom-mcp-servers)

```json
{
  "mcpServers": {
    "blockbench": {
      "serverUrl": "http://127.0.0.1:3000/bb-mcp"
    }
  }
}
```

#### Cline

<img width="674" height="486" alt="Connecting to Blockbench MCP plugin through Cline" src="https://github.com/user-attachments/assets/f27f2304-dd56-4c60-b159-86fbd5af65ee" />

**`cline_mcp_settings.json`**

```json
{
  "mcpServers": {
    "blockbench": {
      "url": "http://127.0.0.1:3000/bb-mcp",
      "type": "streamableHttp",
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

#### Ollama

```bash
uvx ollmcp -u http://127.0.0.1:3000/bb-mcp
```

Recommended: [jonigl/mcp-client-for-ollama](https://github.com/jonigl/mcp-client-for-ollama)

#### OpenCode

```bash
opencode mcp add
```

<img width="504" height="300" alt="Connecting to Blockbench MCP plugin through OpenCode." src="https://github.com/user-attachments/assets/238971fc-0048-4b8d-95dd-6681604bbe90" />

#### Clients that require stdio

For a client configured with a local command, such as Claude Desktop's `claude_desktop_config.json`, use the repository's single-process bridge. Install Node.js 22 or newer, download this repository, and run `bun install --frozen-lockfile` in it once. Keep the repository and its `node_modules` directory available.

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": ["/absolute/path/blockbench-mcp-plugin/scripts/stdio-bridge.mjs", "http://127.0.0.1:3000/bb-mcp"]
    }
  }
}
```

On Windows, use a path such as `D:/tools/blockbench-mcp-plugin/scripts/stdio-bridge.mjs`. If `node` is unavailable in the client's PATH, set `command` to the absolute path of `node.exe`.

The bridge starts one Node.js process per stdio connection. It forwards the client's MCP initialization, messages, and session unchanged, and launches no child processes. It closes the HTTP session and exits when stdin closes, the parent exits, a supported termination signal arrives, or Blockbench becomes unavailable. Cleanup has a two-second deadline. Windows force termination bypasses all JavaScript cleanup; the server's session expiry handles that case.

Initialization times out after 10 seconds. After initialization, the bridge checks the plugin's health every 15 seconds with a five-second timeout. Advanced overrides use milliseconds: `BLOCKBENCH_BRIDGE_STARTUP_TIMEOUT_MS`, `BLOCKBENCH_BRIDGE_HEALTH_INTERVAL_MS`, `BLOCKBENCH_BRIDGE_HEALTH_TIMEOUT_MS`, `BLOCKBENCH_BRIDGE_PARENT_INTERVAL_MS` (default 1000), and `BLOCKBENCH_BRIDGE_SHUTDOWN_TIMEOUT_MS` (default 2000).

#### Migrating an existing connection

Replace existing `npx mcp-remote` or `cmd /c npx mcp-remote` entries with a native HTTP example above, then restart the affected MCP client connections. Those wrappers add process layers for each connection. If a previously launched wrapper remains after its client has closed, identify it by its command line and stop only that old Blockbench wrapper process. The plugin does not terminate unrelated Node.js processes.


## Usage

[See sample project](https://github.com/jasonjgardner/blockbench-mcp-project) for prompt examples.

### Multiple agents and workspaces

Each independently initialized MCP session has its own default workspace. Start by calling `create_project` with the model name and format. The project binds to that workspace; subsequent calls use its project even when another agent or the user has switched the visible Blockbench tab.

If the host shares one MCP connection among multiple agent conversations, assign each agent a distinct `workspace_id` and include it in **every tool call**, starting with `create_project`. Omitting it selects that session's default workspace. For example, agent A uses `workspace_id: "character-a"` and agent B uses `workspace_id: "character-b"`. Independent connections can both omit the field.

Resource listing and reading on a shared connection use `_meta: {"blockbench/workspace_id": "character-a"}`. If the client cannot attach this metadata, use separate HTTP sessions for independent agents. Give each workspace its own export/save file paths and wait until an MCP operation completes before manually editing in Blockbench.

Each project is a Blockbench tab that stays open until closed. When finished, export the model and call `close_project` (with `discard_unsaved: true` if the project has unsaved changes) to free its memory; it only closes projects owned by the calling workspace. To continue an existing model, call `list_projects` and then `select_project` with its UUID as `project_id` and your `workspace_id`, if used. A project already occupied by another workspace cannot be claimed concurrently. Disconnecting releases that session's claims and preserves the open models; reconnect and select the saved/open project to continue.

Operations in Blockbench are serialized, including their awaited asynchronous work, and restore editor state after using the workspace's project. Each workspace's calls keep their order; calls queued by several agents are grouped per workspace for a bounded slice so the editor does not switch projects on every call. After the last call the workspace's model stays open briefly (`mcp_idle_restore_delay`, default 3000 ms, 0 to disable) before your own tab returns. This isolation protects work performed through the project tools; it is not an operating-system sandbox. Global tools (`risky_eval`, `trigger_action`, `emulate_clicks`, `fill_dialog`, `create_brush_preset`, `load_brush_preset`, and `import_texture_set`) are disabled for network clients by default. Enabling `mcp_allow_global_tools` permits them only with a single session and workspace. Continuous animation playback is unavailable in isolated calls; set a timeline time and capture a frame, or preview playback manually. Global scripts must await all their work and must not leave background timers or callbacks that edit the project later.

### [Skills](https://skills.sh/jasonjgardner/blockbench-mcp-project)

Use Agent Skills to orchestrate tool usage.

## Plugin Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed instructions on setting up the development environment and how to add new tools, resources, and prompts.
