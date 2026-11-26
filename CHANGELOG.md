# Changelog

## [Unreleased]

### Added
- **Broker 多窗口架构**：新增 `broker.ts`，首窗口 fork 独立 Broker 进程绑定公共端口，各窗口后端监听随机端口并向 Broker 注册，按 `instanceId`（= session id）路由 MCP 请求。解决 CodeBuddy 多开 VSCode 窗口端口冲突问题。
- **`changePort` 命令**：动态修改 Broker 公共端口，无需重启 VSCode。
- **Host/Origin 头校验**：防 DNS-rebinding 攻击，修正此前「有 Origin 就拒」的过粗逻辑——无 Origin 头放行，有 Origin 时必须指向本地回环。
- **`debug_get_variables_by_name`**：按变量名精确读取（最多 50 个），最小权限模型，复用 `getFrameLocals` 的 names 过滤和脱敏逻辑。
- **`debug_verify_target`**（恢复）：附加前只读校验进程、可执行文件、工作区、引擎类型，`engine` 设为必需。
- **`debug_start_test`**：使用 VSCode Testing API 启动测试运行。
- **`debug_get_broker_status`**：获取 Broker 多窗口路由状态。
- **`debug_list_instances`**：列出 Broker 注册的所有 VSCode 窗口实例。
- **构建脚本**：`scripts/build.mjs`（编译 + lint + 打包 VSIX）。
- **ESLint 配置**：`.eslintrc.json`，修复此前缺依赖无法运行的问题。
- **自动化测试**：`test/` 目录，Broker 路由和 Host 校验测试。

### Fixed
- **单实例自动路由**：仅一个窗口注册时，Broker 不再要求 `instanceId`，静态 `mcp.json` 客户端（VS Code、Claude Code 等）可直接连接 Broker 端口。
- **Broker 注册可靠性**：注册失败自动重试；心跳失败会清除注册状态并在下一拍补注册，避免 Broker 重启后永久失联。
- **修改端口稳定性**：`changePort` 与配置变更监听不再并发重启同一个服务；端口变更时同步重建 Broker。状态栏与详情改为显示客户端应连接的端口（Broker 模式下为 Broker 端口）。

### Changed
- **命令重命名**：`start` → `startServer`，`stop` → `stopServer`，`restart` → `restartServer`（旧命令 ID 不再注册）。
- **`debug_step` 拆分**：拆分为 `debug_step_into`、`debug_step_over`、`debug_step_out` 三个独立工具，对 AI 更直观（无需记忆 `stepAction` 参数）。
- **`package.json`**：新增 `useBroker` 配置项（默认 `true`），新增 `test`/`package` 脚本，补充 eslint 依赖。

### Security
- Host 头校验防 DNS-rebinding（仅允许 `127.0.0.1`、`localhost`、`[::1]`）。
- Origin 头校验修正：有 Origin 时必须指向本地回环，无 Origin 放行（非浏览器请求）。
- `debug_get_variables_by_name` 最小权限读取：仅返回请求的变量名，凭据值自动脱敏。

### Preserved
- `secretRedaction.ts` 脱敏逻辑不变。
- `pauseCaptureManager.ts` pauseId 陈旧防护不变。
- `mcpServer.ts` 工具调用串行化（`_toolChain`）不变。
