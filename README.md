# VSCode Debugger MCP

Visual Studio Code 扩展，将当前活动的 VSCode 调试器暴露为本地 MCP Server，
供 AI 编程助手进行 attach/断点/单步/变量查看等辅助调试。

## 仓库结构

```
VSCodeDebuggerMCP/
├── package.json              # 扩展清单（命令/配置/激活事件）
├── tsconfig.json             # TypeScript 编译配置
├── src/
│   ├── extension.ts          # 扩展入口（激活/停用/命令/状态栏）
│   ├── mcpServer.ts          # MCP HTTP + JSON-RPC 2.0 服务器
│   ├── debuggerService.ts    # 核心调试器服务（工具 1-22）
│   ├── frameOps.ts           # 栈帧/线程/变量/源码操作（工具 23-32）
│   ├── pauseCaptureManager.ts # 暂停捕获系统（工具 33-41）
│   ├── advancedDebugOps.ts   # 数据断点/反汇编/寄存器/内存/源码映射（工具 42-49）
│   ├── toolDefinitions.ts    # 49 个 MCP 工具 JSON schema
│   └── types.ts              # 共享类型/模型
├── .vscode/
│   └── launch.json           # 扩展开发调试配置
└── README.md
```

## 构建与安装

要求：Node.js 18+ 和 VSCode 1.85+。

```bash
npm install
npm run compile
```

开发调试：在 VSCode 中按 `F5`（使用 `.vscode/launch.json` 中的配置）打开扩展开发宿主。

打包 VSIX（需 `@vscode/vsce`）：

```bash
npx @vscode/vsce package
```

安装生成的 `.vsix` 文件后重开 VSCode，扩展自动激活并监听：

```text
http://127.0.0.1:37643/mcp/
```

## 配置 MCP 客户端

```json
{
  "vscode-debugger-mcp": {
    "transportType": "streamable-http",
    "url": "http://127.0.0.1:37643/mcp/",
    "timeout": 60000,
    "description": "VSCode Debugger MCP"
  }
}
```

> CodeBuddy 用 `transportType` 字段；其他 MCP 客户端用 `type`。

## 扩展配置

在 VSCode `settings.json` 中：

```json
{
  "vscodeDebuggerMcp.port": 37643,
  "vscodeDebuggerMcp.autoStart": true
}
```

- `port`：MCP 服务监听端口（1024–65535，默认 37643）
- `autoStart`：扩展激活时是否自动启动 MCP 服务（默认 true）

## 暴露的工具（共 49 个）

| 类别 | 工具 |
|------|------|
| 实例与状态 | debug_get_status、debug_get_instance_info、debug_list_processes、debug_verify_target、debug_attach_process、debug_launch_and_attach、debug_detach_process、debug_select_process |
| 断点 | debug_add_breakpoint、debug_list_breakpoints、debug_set_breakpoint_enabled、debug_remove_breakpoint |
| 执行控制 | debug_start、debug_restart、debug_continue、debug_pause、debug_step_over、debug_step_into、debug_step_out、debug_stop、debug_wait_for_pause、debug_get_stop_reason |
| 线程与栈帧 | debug_list_threads、debug_select_thread、debug_select_frame、debug_get_frame_locals、debug_get_current_frame、debug_get_call_stack、debug_get_source_context、debug_capture_pause_context、debug_get_locals、debug_evaluate |
| 暂停捕获（实验性） | debug_get_pause_capture_status、debug_set_pause_capture_active、debug_add_capture_watch、debug_list_capture_watches、debug_remove_capture_watch、debug_get_latest_pause_capture、debug_list_pause_captures、debug_get_pause_capture、debug_clear_pause_captures |
| 数据断点 | debug_add_data_breakpoint、debug_manage_breakpoint_by_tag |
| 模块 | debug_list_modules |
| 反汇编 | debug_get_disassembly |
| 寄存器 | debug_get_registers |
| 内存 | debug_read_memory |
| 源码映射 | debug_set_source_map、debug_list_source_maps |

## 工作原理

```
AI 客户端 (CodeBuddy/Codex)
    │  MCP = HTTP POST + JSON-RPC 2.0（initialize/ping/tools/list/tools/call）
    ▼  http://127.0.0.1:37643/mcp/
VSCode 扩展内嵌 MCP 服务器
    │  同进程调用
    ▼
DebuggerService → vscode.debug API + DAP customRequest
```

1. VSCode 启动后扩展自动激活（`onStartupFinished`），启动 MCP HTTP 服务器。
2. AI 客户端通过 `initialize` 握手，`tools/list` 获取工具表，`tools/call` 调用工具。
3. 调试操作通过 `vscode.debug` API（断点管理、启动/停止调试）和 DAP `customRequest`
   （continue/step/stackTrace/scopes/variables/evaluate）执行。
4. DAP 事件通过 `DebugAdapterTracker` 追踪：`stopped` 事件记录暂停状态和 pauseId，
   `terminated` 事件清理状态。
5. `continue`/`step` 可带 `expectedPauseId` 做陈旧防护，不匹配返回 `stalePauseContext`。

## 安全说明

- MCP 服务器仅监听 127.0.0.1，不接受外部连接
- 拒绝浏览器跨域请求（OPTIONS / 带 Origin 头的 POST）
- 所有调试操作通过 VSCode 官方 API 执行，受 VSCode 权限模型约束

## 兼容性

- 支持 VSCode 1.85+
- 支持 VSCode 内置调试器及所有通过 DAP 协议的扩展调试器
  （C/C++、Node.js、Python、Go、Java、Rust 等）
