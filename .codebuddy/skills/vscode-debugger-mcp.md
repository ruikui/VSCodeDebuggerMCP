---
name: vscode-debugger-mcp
description: VSCode Debugger MCP 工具集使用指南。当需要通过 MCP 协议控制 VSCode 调试器（附加进程、设断点、单步、读取变量、捕获暂停上下文、多窗口路由）时使用此 Skill。
---

# VSCode Debugger MCP 使用指南

## 概述

VSCode Debugger MCP 是一个 VSCode 扩展，通过 HTTP + JSON-RPC 2.0 暴露 MCP 协议接口，允许 AI 助手控制 VSCode 调试器。

## 多窗口架构（Broker）

- 首个 VSCode 窗口 fork 独立 Broker 进程，绑定公共端口（默认 37643）
- 各窗口后端监听随机端口，向 Broker 注册
- Broker 按 `instanceId`（= session id）路由 MCP 请求
- 使用 `debug_list_instances` 列出所有窗口
- 使用 `debug_get_broker_status` 查看当前窗口的路由状态

## 工具分类

### 实例与状态
- `debug_get_status` — 获取实例信息、调试器模式、进程、线程、停止原因
- `debug_get_broker_status` — Broker 多窗口路由状态
- `debug_list_instances` — 列出所有注册的窗口实例
- `debug_list_processes` — 列出系统进程

### 目标校验与附加
- `debug_verify_target` — **附加前只读校验**（进程、可执行文件、工作区、引擎类型）。`engine` 必需
- `debug_attach_process` — 附加到进程
- `debug_launch_and_attach` — 启动并附加
- `debug_detach_process` / `debug_select_process`

### 断点
- `debug_add_breakpoint` / `debug_add_logpoint`
- `debug_list_breakpoints` / `debug_set_breakpoint_enabled`
- `debug_remove_breakpoint` / `debug_clear_all_breakpoints`

### 执行控制
- `debug_start` / `debug_restart` / `debug_stop`
- `debug_continue` / `debug_pause`
- `debug_step_into` / `debug_step_over` / `debug_step_out` — 单步（需 `expectedPauseId`）
- `debug_wait_for_pause` — 等待中断
- `debug_start_test` — 使用 Testing API 启动测试

### 线程与栈帧
- `debug_list_threads` / `debug_select_thread` / `debug_select_frame`
- `debug_get_call_stack` — 调用栈（含当前帧）
- `debug_get_frame_locals` — 读取栈帧局部变量（支持 `names` 过滤）
- `debug_list_variable_names` — 仅枚举变量名和类型
- `debug_get_variables_by_name` — **按名精确读取**（最多 50 个，最小权限）
- `debug_get_source_context` / `debug_capture_pause_context`
- `debug_evaluate` — 表达式求值

### 暂停捕获
- `debug_get_pause_capture_status` / `debug_set_pause_capture_active`
- `debug_add_capture_watch` / `debug_list_capture_watches` / `debug_remove_capture_watch`
- `debug_list_pause_captures` / `debug_get_pause_capture` / `debug_clear_pause_captures`

### 高级调试
- `debug_add_data_breakpoint` / `debug_manage_breakpoint_by_tag`
- `debug_list_modules` / `debug_get_disassembly`
- `debug_get_registers` / `debug_read_memory`
- `debug_set_source_map` / `debug_list_source_maps`

## 安全特性

- **Host 头校验**：仅允许 `127.0.0.1`、`localhost`、`[::1]`（防 DNS-rebinding）
- **Origin 头校验**：有 Origin 时必须指向本地回环，无 Origin 放行
- **变量脱敏**：凭据值自动脱敏（`secretRedaction.ts`）
- **pauseId 陈旧防护**：所有栈帧操作支持 `expectedPauseId` 检测陈旧暂停上下文
- **最小权限读取**：`debug_get_variables_by_name` 仅返回请求的变量名

## 典型工作流

1. `debug_verify_target` → 校验目标
2. `debug_attach_process` → 附加
3. `debug_add_breakpoint` → 设断点
4. `debug_continue` → 继续
5. `debug_wait_for_pause` → 等待中断
6. `debug_get_call_stack` → 查看调用栈
7. `debug_get_variables_by_name` → 按名读取变量
8. `debug_step_over` → 单步
