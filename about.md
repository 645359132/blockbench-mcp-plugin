## Model Context Protocol Server
Configure experimental MCP server under Blockbench settings: __Settings__ > __General__ > __MCP Server Port__ and __MCP Server Endpoint__

The following examples use the default URL `http://127.0.0.1:3000/bb-mcp`. Use native HTTP connections when supported to avoid extra Node.js processes.

> __Be sure your Blockbench settings match the port and endpoint used in the MCP JSON configuration.__

## Installation

### Clients requiring stdio (including Claude Desktop local configuration)

Download this repository, install its dependencies once with `bun install --frozen-lockfile`, and use Node.js 22+ with the absolute bridge path below.

__`claude_desktop_config.json`__

```json
{
  "mcpServers": {
    "blockbench": {
      "command": "node",
      "args": [
        "/absolute/path/blockbench-mcp-plugin/scripts/stdio-bridge.mjs",
        "http://127.0.0.1:3000/bb-mcp"
      ]
    }
  }
}
```

### VS Code

<span style="background: darkred; box-shadow: 1px 1px 6px rgba(0 0 0 / 50%); color: pink; font: 600 12px sans-serif; padding: 0.3em 0.5em; border-radius: 0.25em; outline: 0.125em solid red;">Unstable</span>

> This plugin _should_ be compatible but Copilot often throws errors when using most tools.

__`.vscode/mcp.json`__

```json
{
    "servers": {
        "blockbench": {
            "type": "http",
            "url": "http://127.0.0.1:3000/bb-mcp"
        }
    }
}
```

## Basic Usage

1. Start Blockbench
2. Start your MCP client
3. Enable/disable tools in client
4. Call `create_project` to bind a new model, or `list_projects` then `select_project` to resume an open model.
5. Agents sharing one connection must pass a distinct `workspace_id` on every tool call. Separate connections each have their own default workspace.

### Limitations / Expectations

Only a small fraction of Blockbench's API has been mapped to a MCP server tool, so some capabilities may be limited.

"One-shotting" a model is possible but human-in-the-loop interaction and project clean-up should usually be expected.

### Tips

- __Set the agent up for success__ by adding textures and groups to the project ahead of prompting.
- __Find the right amount of context__ by disabling tools you do not want or need, _but also_ try providing lots of specific project details and even __use other MCP servers in the same context.__ (i.e. File or web access tools.)
- __Make a backup.__ This is experimental tech! Working in existing projects may yield unexpected results.
