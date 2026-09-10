## Installation

- [Stable](https://jasonjgardner.github.io/blockbench-mcp-plugin/mcp.js)
- [Latest](https://jasonjgardner.github.io/blockbench-mcp-plugin/nightly/mcp.js)

Connect to the plugin with native Streamable HTTP at `http://127.0.0.1:3000/bb-mcp` (or the port and endpoint configured in Blockbench). The server runs inside Blockbench and HTTP clients start no extra Node.js process.

Codex configuration:

```toml
[mcp_servers.blockbench]
url = "http://127.0.0.1:3000/bb-mcp"
```

See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

Each independently initialized MCP connection has its own default workspace. Agents sharing a connection must each use a distinct `workspace_id` on every tool call; resource calls use `_meta: {"blockbench/workspace_id": "your-workspace"}`. Use separate HTTP sessions if the client cannot attach resource metadata.

For clients that require stdio, use `node /absolute/path/blockbench-mcp-plugin/scripts/stdio-bridge.mjs http://127.0.0.1:3000/bb-mcp` after installing the repository dependencies. The bridge uses one process, watches stdin and its parent, checks server health, and bounds session shutdown to two seconds.

Replace older `npx mcp-remote` connection entries and restart the affected clients. See the repository's [complete installation guide](https://github.com/jasonjgardner/blockbench-mcp-plugin/blob/main/llms-install.md) for client-specific configuration and cleanup behavior.
