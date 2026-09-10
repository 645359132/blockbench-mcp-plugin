# 多 Agent 建模与进程生命周期

本次审查修复了两个主要问题：原来的 MCP 会话只隔离连接，建模仍使用同一个全局 `Project`；安装示例通过 `npx` 启动 `mcp-remote`，每个客户端会产生额外进程层。

## 使用方式

优先让客户端直接连接 `http://127.0.0.1:3000/bb-mcp`。例如 Codex：

```toml
[mcp_servers.blockbench]
url = "http://127.0.0.1:3000/bb-mcp"
```

每个独立 MCP 连接有自己的默认工作区。先调用 `create_project`；已有模型先用 `list_projects` 查 UUID，再调用 `select_project`。工具不会自动接管当前可见的模型。

如果宿主为多个 Agent 共享一个连接，每个 Agent 必须选择独立的 `workspace_id`，并在每次工具调用中传入。例如：

```json
{"name":"create_project","arguments":{"name":"角色A","format":"bedrock","workspace_id":"agent-a"}}
{"name":"get_project_info","arguments":{"workspace_id":"agent-a"}}
```

另一个 Agent 使用 `agent-b`。共享连接的资源读取、资源列表请求通过 `_meta: {"blockbench/workspace_id":"agent-a"}` 指定工作区；不支持这项元数据的客户端应使用独立连接。不同模型使用独立的导出文件路径。

仅支持 stdio 的客户端可使用 `node` 直接运行 `scripts/stdio-bridge.mjs`，具体配置见 [安装说明](../llms-install.md)。这种连接保留一个 Node 进程；HTTP 直连不需要桥接进程。

## 实现边界

- 工作区独占绑定的项目；其他工作区不能接管。断开释放占用，保留打开的模型，重连后可重新绑定。
- Blockbench 的编辑器仍只有一个当前项目。所有网络工具和资源操作在同一队列中执行，等待异步工作结束后才切换下一项。
- 调用前恢复目标模型与相机、画笔实际参数、时间轴及关键帧选择；调用后恢复原项目或起始页面。用户手动操作应等待正在执行的工具完成。
- 创建贴图等待原生图像加载完成；加载失败或超时会取消回调并回滚 Undo。隔离调用把文件读为内部贴图，避免文件监听器在后续工作区运行时修改模型。原生浏览器不支持的图片格式应先转换为 PNG。
- 全局 JavaScript、UI 操作、共享画笔预设及原生贴图集导入默认限制。`mcp_allow_global_tools` 开启后也只允许一个会话、一个持有模型的工作区使用。这些入口可访问整个编辑器，脚本必须等待全部异步工作完成。
- 持续动画播放会跨越工具调用结束，因此网络隔离调用使用指定时间加截图查看动画帧；连续播放可在 Blockbench 界面操作。

## 进程与连接清理

插件关闭监听器时，一并关闭已接受的 socket、SSE reader、心跳、MCP server 和 transport。失败初始化也会清理分配的对象。真实建模请求在执行和排队期间保活；仅 ping/pong 不会让闲置会话永久存活。

stdio bridge 在输入关闭、父进程退出、服务不可用时结束。远端健康检查默认每 15 秒进行，超时 5 秒，关闭清理最多等待 2 秒。它不启动子进程。Windows 强制结束进程无法执行 JavaScript 清理，服务端会按会话超时回收剩余连接状态。

旧客户端配置中的 `npx mcp-remote` 需要替换并重启对应连接。插件不会清理无关 Node 进程。

## 验证

自动测试覆盖真实 HTTP 与 SDK 双客户端、共享连接工作区、完整异步调用串行执行、资源范围、占用冲突、取消和断开、socket/SSE 清理、Node 父进程退出、贴图回调与回滚、画笔和相机状态恢复。测试使用模拟的 Blockbench 模型对象；真实界面的模型编辑与热重载仍需按 [手工验收步骤](../CONTRIBUTING.md) 检查。

构建产物为 `dist/mcp.js`；安装后加载该文件。`bun run docs` 生成文档后退出，预览服务单独使用 `bun run docs:serve`。
