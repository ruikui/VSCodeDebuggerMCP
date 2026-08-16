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
│   ├── mcpServer.ts          # MCP HTTP + JSON-RPC 2.0 服务器（44 个工具分发）
│   ├── debuggerService.ts    # 核心调试器服务（工具 1-19）
│   ├── frameOps.ts           # 栈帧/线程/变量/源码操作（工具 20-28）
│   ├── pauseCaptureManager.ts # 暂停捕获系统（工具 29-36）
│   ├── advancedDebugOps.ts   # 数据断点/反汇编/寄存器/内存/源码映射（工具 37-44）
│   ├── secretRedaction.ts    # 变量脱敏工具（敏感值检测与擦除）
│   ├── toolDefinitions.ts    # 44 个 MCP 工具 JSON schema
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

## 暴露的工具（共 44 个）

| 类别 | 工具 |
|------|------|
| 实例与状态 | debug_get_status、debug_list_processes、debug_attach_process、debug_launch_and_attach、debug_detach_process、debug_select_process |
| 断点 | debug_add_breakpoint、debug_add_logpoint、debug_list_breakpoints、debug_set_breakpoint_enabled、debug_remove_breakpoint、debug_clear_all_breakpoints |
| 执行控制 | debug_start、debug_restart、debug_continue、debug_pause、debug_step、debug_stop、debug_wait_for_pause |
| 线程与栈帧 | debug_list_threads、debug_select_thread、debug_select_frame、debug_get_frame_locals、debug_list_variable_names、debug_get_call_stack、debug_get_source_context、debug_capture_pause_context、debug_evaluate |
| 暂停捕获 | debug_get_pause_capture_status、debug_set_pause_capture_active、debug_add_capture_watch、debug_list_capture_watches、debug_remove_capture_watch、debug_list_pause_captures、debug_get_pause_capture、debug_clear_pause_captures |
| 数据断点 | debug_add_data_breakpoint、debug_manage_breakpoint_by_tag |
| 模块 | debug_list_modules |
| 反汇编 | debug_get_disassembly |
| 寄存器 | debug_get_registers |
| 内存 | debug_read_memory |
| 源码映射 | debug_set_source_map、debug_list_source_maps |

### 工具合并说明

以下旧工具已合并为更精简的接口：

| 旧工具 | 合并到 | 说明 |
|--------|--------|------|
| debug_get_instance_info | debug_get_status | 实例信息与暂停状态合并为统一状态查询 |
| debug_verify_target | debug_attach_process / debug_launch_and_attach | 验证逻辑内联到 attach/launch 流程 |
| debug_step_over / debug_step_into / debug_step_out | debug_step | 三种单步合并为 `stepAction` 参数（`into`/`over`/`out`） |
| debug_get_stop_reason | debug_get_status | 停止原因内联到状态返回 |
| debug_get_current_frame | debug_get_call_stack | 当前帧信息内联到调用栈返回 |
| debug_get_locals | debug_get_frame_locals | 局部变量合并到帧局部查询 |
| debug_get_latest_pause_capture | debug_get_pause_capture | 省略 captureId 时默认返回最新捕获 |

### 陈旧防护机制

`debug_continue`、`debug_step`、`debug_select_thread`、`debug_select_frame` 等变更执行状态的工具
支持可选的 `expectedPauseId` 参数。当传入的 pauseId 与当前不匹配时，操作被拒绝并返回
`stalePauseContext` 错误，同时响应中携带 `stale: true` 标志，提示 AI 客户端重新获取状态。

`debug_get_status`、`debug_get_call_stack`、`debug_get_frame_locals`、`debug_list_variable_names`、
`debug_capture_pause_context` 等只读工具同样支持 `expectedPauseId`，不匹配时返回 `stale: true`
及空数据，避免 AI 基于过时上下文做决策。

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
5. `continue`/`step` 等可带 `expectedPauseId` 做陈旧防护，不匹配返回 `stalePauseContext`。

## 变量脱敏

变量返回路径（`debug_get_frame_locals`、`debug_get_call_stack`、`debug_capture_pause_context` 等）
经过 `secretRedaction.ts` 的自动脱敏处理。检测到疑似敏感值（API Key、Token、密码等）时，
值被替换为 `<redacted: possible secret>`，并在响应中标记 `redacted: true` 及 `redactionNotice`。

## 安全说明

- MCP 服务器仅监听 127.0.0.1，不接受外部连接
- 拒绝浏览器跨域请求（OPTIONS / 带 Origin 头的 POST）
- 所有调试操作通过 VSCode 官方 API 执行，受 VSCode 权限模型约束
- 变量值自动脱敏，防止敏感信息泄露给 AI 客户端

## 兼容性

- 支持 VSCode 1.85+
- 支持 VSCode 内置调试器及所有通过 DAP 协议的扩展调试器
  （C/C++、Node.js、Python、Go、Java、Rust 等）
