# VSCode Debugger MCP

Visual Studio Code 扩展，将当前活动的 VSCode 调试器暴露为本地 MCP Server，
供 AI 编程助手进行 attach/断点/单步/变量查看等辅助调试。

## 特性

- **Broker 多窗口架构**：多开 VSCode 窗口不再端口冲突。首个窗口 fork 独立 Broker 进程绑定公共端口，各窗口后端监听随机端口并向 Broker 注册，Broker 按 `instanceId`（= session id）路由请求到对应窗口。
- **安全防护**：Host 头校验（防 DNS-rebinding）、Origin 头校验（无 Origin 放行、有 Origin 必须本地回环）、变量值自动脱敏、`debug_get_variables_by_name` 最小权限读取（最多 50 个变量名）。
- **51 个 MCP 工具**：覆盖实例/进程、断点、执行控制、线程/栈帧/变量、暂停捕获、数据断点、反汇编/寄存器/内存、源码映射。
- **附加前只读校验**：`debug_verify_target` 在 attach 前校验进程/可执行文件/工作区/引擎，不修改任何状态。
- **Testing API**：`debug_start_test` 使用 VSCode Testing API 启动测试运行。
- **陈旧暂停防护**：执行类与只读类工具均支持 `expectedPauseId`，避免 AI 基于过时上下文操作。

## 仓库结构

```
VSCodeDebuggerMCP/
├── package.json              # 扩展清单（命令/配置/激活事件）
├── tsconfig.json             # TypeScript 编译配置
├── .eslintrc.json            # ESLint 配置
├── CHANGELOG.md              # 变更日志
├── src/
│   ├── extension.ts          # 扩展入口（激活/停用/命令/状态栏/Broker fork）
│   ├── broker.ts             # Broker 多窗口路由进程（注册/心跳/注销/instanceId 转发）
│   ├── mcpServer.ts          # MCP HTTP + JSON-RPC 2.0 服务器（51 个工具分发 + 安全校验）
│   ├── debuggerService.ts    # 核心调试器服务（实例/进程/attach/断点/执行控制）
│   ├── frameOps.ts           # 栈帧/线程/变量/源码操作
│   ├── pauseCaptureManager.ts # 暂停捕获系统
│   ├── advancedDebugOps.ts   # 数据断点/反汇编/寄存器/内存/源码映射
│   ├── secretRedaction.ts    # 变量脱敏工具（敏感值检测与擦除）
│   ├── toolDefinitions.ts    # 51 个 MCP 工具 JSON schema
│   └── types.ts              # 共享类型/模型
├── scripts/
│   └── build.mjs             # 构建脚本（lint → 编译 → 打包 VSIX）
├── test/
│   ├── runTests.ts           # 测试入口（汇总全部测试组）
│   ├── brokerRoute.test.ts   # Broker 注册/心跳/路由测试
│   ├── secretRedaction.test.ts # 脱敏逻辑单元测试
│   └── toolDefinitions.test.ts # 工具定义完整性测试
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

### 自动化测试

```bash
npm test
```

运行 `out/test/runTests.js`，覆盖 Broker 启动/健康检查/Host 校验/实例注册与路由/Origin 校验、脱敏逻辑、工具定义完整性，共 101 项断言。

### 构建脚本

```bash
node scripts/build.mjs                 # lint + 编译 + 打包 VSIX
node scripts/build.mjs --no-package    # 仅 lint + 编译
node scripts/build.mjs --lint-only     # 仅 lint
```

也可直接使用 npm 脚本：

```bash
npm run lint       # ESLint（src/*.ts）
npm run package    # vsce package（打包 VSIX）
```

### 打包与安装 VSIX

```bash
node scripts/build.mjs
```

生成 `.vsix` 文件后重开 VSCode，扩展自动激活并监听：

```text
http://127.0.0.1:37643/mcp/
```

## 配置 MCP 客户端

### 单窗口直连模式（`useBroker: false`）

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

### 多窗口 Broker 模式（`useBroker: true`，默认）

Broker 绑定公共端口（默认 37643），客户端请求需携带 `instanceId` 将请求路由到指定窗口：

- 通过查询参数：`POST http://127.0.0.1:37643/mcp?instanceId=<id>`
- 或通过请求头：`X-Instance-Id: <id>`

先调用 `debug_list_instances` 获取已注册的窗口 `instanceId` 列表，再选择目标窗口路由。
若客户端不支持自定义请求头/查询参数，可将 `vscodeDebuggerMcp.useBroker` 设为 `false` 退回单窗口直连模式。

## 扩展配置

在 VSCode `settings.json` 中：

```json
{
  "vscodeDebuggerMcp.port": 37643,
  "vscodeDebuggerMcp.autoStart": true,
  "vscodeDebuggerMcp.useBroker": true
}
```

- `port`：Broker/后端监听端口（1024–65535，默认 37643）
- `autoStart`：扩展激活时是否自动启动 MCP 服务（默认 true）
- `useBroker`：是否使用 Broker 多窗口架构（默认 true）。关闭后后端直接绑定 `port`，回退为单窗口直连。

## 命令

新版提供 5 个命令（命令面板输入 "VSCode Debugger MCP" 查看）：

| 命令 ID | 说明 |
|---------|------|
| `vscodeDebuggerMcp.showStatus` | 打开操作菜单（开始/停止/重启/改端口/查看详细状态） |
| `vscodeDebuggerMcp.startServer` | 开始 MCP 服务 |
| `vscodeDebuggerMcp.stopServer` | 停止 MCP 服务 |
| `vscodeDebuggerMcp.restartServer` | 重启 MCP 服务 |
| `vscodeDebuggerMcp.changePort` | 动态修改端口（弹窗输入新端口，自动重启 Broker 与后端） |

状态栏右侧常驻 `VSCodeDebugMCP` 指示器，点击可打开操作菜单，实时显示端口与调试状态（`paused`/`running`/`Off`）。

## 暴露的工具（共 51 个）

| 类别 | 工具 |
|------|------|
| 实例与状态 | debug_get_status、debug_get_broker_status、debug_list_instances、debug_list_processes、debug_verify_target、debug_attach_process、debug_launch_and_attach、debug_detach_process、debug_select_process |
| 断点 | debug_add_breakpoint、debug_add_logpoint、debug_list_breakpoints、debug_set_breakpoint_enabled、debug_remove_breakpoint、debug_clear_all_breakpoints |
| 执行控制 | debug_start、debug_restart、debug_continue、debug_pause、debug_step_into、debug_step_over、debug_step_out、debug_stop、debug_wait_for_pause、debug_start_test |
| 线程与栈帧 | debug_list_threads、debug_select_thread、debug_select_frame、debug_get_frame_locals、debug_list_variable_names、debug_get_variables_by_name、debug_get_call_stack、debug_get_source_context、debug_capture_pause_context、debug_evaluate |
| 暂停捕获 | debug_get_pause_capture_status、debug_set_pause_capture_active、debug_add_capture_watch、debug_list_capture_watches、debug_remove_capture_watch、debug_list_pause_captures、debug_get_pause_capture、debug_clear_pause_captures |
| 数据断点 | debug_add_data_breakpoint、debug_manage_breakpoint_by_tag |
| 模块 | debug_list_modules |
| 反汇编 | debug_get_disassembly |
| 寄存器 | debug_get_registers |
| 内存 | debug_read_memory |
| 源码映射 | debug_set_source_map、debug_list_source_maps |

### 新增工具

| 工具 | 说明 |
|------|------|
| `debug_verify_target` | 附加前只读校验：检查进程是否存在、可执行文件路径/工作区是否匹配、引擎是否支持。`engine`/`expectedExecutable`/`expectedSolution` 为必需字段，不修改任何状态。 |
| `debug_start_test` | 使用 VSCode Testing API 启动测试运行，支持按 `testIds` 运行指定测试或整个测试套件。 |
| `debug_get_variables_by_name` | 按变量名精确读取指定栈帧的变量值（最小权限读取），最多 50 个变量名，仅返回匹配变量，凭据值自动脱敏。 |
| `debug_get_broker_status` | 获取 Broker 多窗口路由状态：当前实例的 instanceId、后端端口、Broker 端口、注册状态。 |
| `debug_list_instances` | 列出 Broker 注册的所有 VSCode 窗口实例（instanceId 和端口），用于多会话路由。 |

### 工具合并/拆分说明

| 工具 | 变更 | 说明 |
|------|------|------|
| debug_get_instance_info | 合并到 debug_get_status | 实例信息与暂停状态合并为统一状态查询 |
| debug_get_stop_reason | 合并到 debug_get_status | 停止原因内联到状态返回 |
| debug_get_current_frame | 合并到 debug_get_call_stack | 当前帧信息内联到调用栈返回 |
| debug_get_locals | 合并到 debug_get_frame_locals | 局部变量合并到帧局部查询 |
| debug_get_latest_pause_capture | 合并到 debug_get_pause_capture | 省略 captureId 时默认返回最新捕获 |
| debug_step | 拆分为 debug_step_into / debug_step_over / debug_step_out | 三种单步拆为独立工具，对 AI 更直观，不再用 `stepAction` 参数 |

### 最小权限读取模型

推荐 AI 客户端遵循「先枚举、再按需读取」的最小权限流程：

1. `debug_list_variable_names` 枚举变量名（不读取值，凭据不在此泄漏）
2. `debug_get_variables_by_name` 或 `debug_get_frame_locals`（`names` 白名单）按名精确取值

### 陈旧防护机制

`debug_continue`、`debug_step_into`、`debug_step_over`、`debug_step_out`、`debug_select_thread`、
`debug_select_frame` 等变更执行状态的工具支持可选的 `expectedPauseId` 参数。当传入的 pauseId 与
当前不匹配时，操作被拒绝并返回 `stalePauseContext` 错误，同时响应中携带 `stale: true` 标志，
提示 AI 客户端重新获取状态。

`debug_get_status`、`debug_get_call_stack`、`debug_get_frame_locals`、`debug_list_variable_names`、
`debug_capture_pause_context` 等只读工具同样支持 `expectedPauseId`，不匹配时返回 `stale: true`
及空数据，避免 AI 基于过时上下文做决策。

## 工作原理

```
AI 客户端 (CodeBuddy/Codex)
    │  MCP = HTTP POST + JSON-RPC 2.0（initialize/ping/tools/list/tools/call）
    ▼
Broker 进程（绑定公共端口 37643，按 instanceId 路由）
    │  转发到对应窗口后端
    ▼
VSCode 扩展内嵌 MCP 后端（各窗口监听随机端口，注册到 Broker）
    │  同进程调用
    ▼
DebuggerService → vscode.debug API + DAP customRequest
```

1. VSCode 启动后扩展自动激活（`onStartupFinished`）。若启用 Broker，首个窗口 fork 独立
   `broker.js` 进程绑定公共端口；各窗口后端 `listen(0)` 绑定随机端口，随后向 Broker `/register`
   注册，并定期 `/heartbeat` 保持存活（30s 无心跳视为失联）。
2. 后端将 `instanceId`（= session id）上报给 Broker；AI 客户端通过 `X-Instance-Id` 头或
   `?instanceId=` 查询参数指定目标窗口，Broker 据此转发 JSON-RPC 请求。
3. AI 客户端通过 `initialize` 握手，`tools/list` 获取工具表，`tools/call` 调用工具。
4. 调试操作通过 `vscode.debug` API（断点管理、启动/停止调试）和 DAP `customRequest`
   （continue/step/stackTrace/scopes/variables/evaluate）执行。
5. DAP 事件通过 `DebugAdapterTracker` 追踪：`stopped` 事件记录暂停状态和 pauseId，
   `terminated` 事件清理状态。
6. `continue`/`step_*` 等可带 `expectedPauseId` 做陈旧防护，不匹配返回 `stalePauseContext`。
7. 所有实例注销后（空闲超时）Broker 自动退出。

## 变量脱敏

变量返回路径（`debug_get_frame_locals`、`debug_get_call_stack`、`debug_capture_pause_context`、
`debug_get_variables_by_name` 等）经过 `secretRedaction.ts` 的自动脱敏处理。检测到疑似敏感值
（API Key、Token、密码、JWT、PEM 私钥、AWS/GitHub 等凭据形状）时，值被替换为
`<redacted: possible secret>`，并在响应中标记 `redacted: true` 及 `redactionNotice`。

## 安全说明

- MCP 服务器与 Broker 均仅监听 127.0.0.1，不接受外部连接
- Host 头校验：仅允许 `127.0.0.1` / `localhost` / `[::1]`，防 DNS-rebinding 攻击
- Origin 头校验：无 Origin（非浏览器请求）放行；有 Origin 必须为本地回环，拒绝跨域
- 所有调试操作通过 VSCode 官方 API 执行，受 VSCode 权限模型约束
- 变量值自动脱敏，并提供按名精确读取的最小权限接口，防止敏感信息泄露给 AI 客户端

## 兼容性

- 支持 VSCode 1.85+
- 支持 VSCode 内置调试器及所有通过 DAP 协议的扩展调试器
  （C/C++、Node.js、Python、Go、Java、Rust 等）
