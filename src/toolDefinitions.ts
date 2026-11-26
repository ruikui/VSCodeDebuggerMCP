import { McpTool } from './types';

/**
 * MCP 工具定义表：完整对齐 VisualStudioDebugger 参考项目的 44 个工具（合并精简后）。
 * 参数名与 schema 与参考项目保持一致，描述适配 VSCode 语境。
 */
export const ToolDefinitions: McpTool[] = [
    // ═══ 实例与状态 ═══
    {
        name: 'debug_get_status',
        description: '获取当前 VSCode 实例信息（instanceId/ide/version/workspace）、调试器模式、进程、线程、停止原因。可选传 expectedPauseId 检测陈旧暂停上下文（合并了原 debug_get_instance_info 和 debug_get_stop_reason）。',
        inputSchema: {
            type: 'object',
            properties: {
                expectedPauseId: { type: 'string', description: '可选。传入已知 pauseId，若与当前不匹配则返回 stale: true。' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_get_broker_status',
        description: '获取 Broker 多窗口路由状态：当前实例的 instanceId、客户端端点（Broker 模式下为 Broker 端口）、后端端点/端口、Broker 端口、注册状态、运行状态。用于多会话路由诊断。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'debug_list_instances',
        description: '列出 Broker 注册的所有 VSCode 窗口实例（instanceId 和后端端口）。用于多会话路由：AI 可据此选择目标 instanceId 路由请求到特定窗口；客户端应连接返回的 endpoint（Broker 端口），后端端口仅供路由诊断。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'debug_list_processes',
        description: '列出本地进程，可按名称过滤。',
        inputSchema: {
            type: 'object',
            properties: {
                nameFilter: { type: 'string', description: '可选，不区分大小写的进程路径或名称子串过滤' },
                limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
            },
            additionalProperties: false
        }
    },
    // ═══ 3. debug_verify_target（恢复：附加前只读校验） ═══
    {
        name: 'debug_verify_target',
        description: '在 attach 前只读校验目标：检查进程是否存在、可执行文件路径是否匹配、工作区是否匹配、调试引擎类型是否支持。不修改任何状态。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1, description: '目标进程 PID' },
                processName: { type: 'string', description: '可选。精确可执行文件名或完整进程路径。仅在省略 processId 时使用。' },
                expectedExecutable: { type: 'string', description: '必需的绝对可执行文件路径。' },
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径。' },
                engine: { type: 'string', description: '必需的调试器类型，例如 cppdbg、node、python、go' }
            },
            required: ['expectedExecutable', 'expectedSolution', 'engine'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_attach_process',
        description: '在验证可执行文件路径和工作区路径后，将 VSCode attach 到一个进程。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1 },
                processName: { type: 'string', description: '精确可执行文件名或完整进程路径。仅在省略 processId 时使用。' },
                expectedExecutable: { type: 'string', description: '必需的绝对可执行文件路径。如果 PID 解析到其他可执行文件则拒绝 attach。' },
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径。如果此 VSCode 打开了其他工作区则拒绝 attach。' },
                engine: { type: 'string', description: '可选调试器类型，例如 cppdbg、node、python、go' }
            },
            required: ['expectedExecutable', 'expectedSolution'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_launch_and_attach',
        description: '启动绝对路径可执行文件，验证工作区路径后将 VSCode attach 到它。',
        inputSchema: {
            type: 'object',
            properties: {
                executable: { type: 'string', description: '必需的现有可执行文件绝对路径' },
                arguments: { type: 'string' },
                workingDirectory: { type: 'string', description: '可选绝对工作目录，默认为可执行文件目录' },
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径' },
                engine: { type: 'string', description: '可选调试器类型' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, default: 30000 }
            },
            required: ['executable', 'expectedSolution'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_detach_process',
        description: '从调试进程分离而不终止它。默认为当前进程。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_select_process',
        description: '当 VSCode 调试多个进程时，选择当前调试进程。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1 }
            },
            required: ['processId'],
            additionalProperties: false
        }
    },

    // ═══ 断点 ═══
    {
        name: 'debug_add_breakpoint',
        description: '在绝对文件路径和 1-based 行号处添加源码断点，可选条件。',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: '必需的绝对源文件路径' },
                line: { type: 'integer', minimum: 1 },
                condition: { type: 'string' }
            },
            required: ['file', 'line'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_add_logpoint',
        description: '在绝对文件路径和 1-based 行号处添加日志断点（logpoint），命中时输出 logMessage 到调试控制台而不中断。logMessage 可用 {expression} 插值。',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string', description: '必需的绝对源文件路径' },
                line: { type: 'integer', minimum: 1 },
                logMessage: { type: 'string', description: '必需。输出到调试控制台的文本，可用 {expr} 插值变量。' }
            },
            required: ['file', 'line', 'logMessage'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_list_breakpoints',
        description: '列出所有断点及其启用状态、位置、条件和命中次数。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'debug_set_breakpoint_enabled',
        description: '通过文件、行号和可选条件精确启用或禁用一个断点。',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                line: { type: 'integer', minimum: 1 },
                condition: { type: 'string' },
                enabled: { type: 'boolean' }
            },
            required: ['file', 'line', 'enabled'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_remove_breakpoint',
        description: '通过文件、行号和可选条件精确删除一个断点。',
        inputSchema: {
            type: 'object',
            properties: {
                file: { type: 'string' },
                line: { type: 'integer', minimum: 1 },
                condition: { type: 'string' }
            },
            required: ['file', 'line'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_clear_all_breakpoints',
        description: '清除所有断点（含源码断点、日志断点、函数断点、数据断点）。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },

    // ═══ 执行控制 ═══
    {
        name: 'debug_start',
        description: '开始调试工作区的配置启动目标。需要预期工作区路径。',
        inputSchema: {
            type: 'object',
            properties: {
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径' }
            },
            required: ['expectedSolution'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_restart',
        description: '验证 PID、可执行文件和工作区后重启当前调试会话。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1 },
                expectedExecutable: { type: 'string' },
                expectedSolution: { type: 'string' }
            },
            required: ['processId', 'expectedExecutable', 'expectedSolution'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_continue',
        description: '恢复执行。需要当前 pauseId，防止陈旧客户端继续已恢复的会话。',
        inputSchema: {
            type: 'object',
            properties: {
                expectedPauseId: { type: 'string' }
            },
            required: ['expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_pause',
        description: '中断运行中的被调试程序。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1, description: '可选。保留用于兼容性，实际中断的是当前活跃调试会话。' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_step_into',
        description: '步进（Step Into）：进入函数内部。需要当前 pauseId。',
        inputSchema: {
            type: 'object',
            properties: { expectedPauseId: { type: 'string' } },
            required: ['expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_step_over',
        description: '步过（Step Over）：跳过函数调用。需要当前 pauseId。',
        inputSchema: {
            type: 'object',
            properties: { expectedPauseId: { type: 'string' } },
            required: ['expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_step_out',
        description: '步出（Step Out）：跳出当前函数。需要当前 pauseId。',
        inputSchema: {
            type: 'object',
            properties: { expectedPauseId: { type: 'string' } },
            required: ['expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_stop',
        description: '终止活动调试会话。',
        inputSchema: {
            type: 'object',
            properties: {
                processId: { type: 'integer', minimum: 1, description: '可选。保留用于兼容性，实际终止的是当前活跃调试会话。' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_wait_for_pause',
        description: '等待调试器进入中断模式并返回新的 pauseId 和停止原因。',
        inputSchema: {
            type: 'object',
            properties: {
                timeoutMs: { type: 'integer', minimum: 100, maximum: 120000, default: 30000 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_start_test',
        description: '使用 VSCode Testing API 启动测试运行。支持按测试 ID 运行指定测试，或运行整个测试套件。',
        inputSchema: {
            type: 'object',
            properties: {
                testIds: { type: 'array', items: { type: 'string' }, description: '要运行的测试 ID 列表。省略时运行所有测试。' },
                controllerId: { type: 'string', description: '可选。测试控制器 ID。省略时自动检测。' },
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径。' },
                timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 }
            },
            required: ['expectedSolution'],
            additionalProperties: false
        }
    },

    // ═══ 线程与栈帧 ═══
    {
        name: 'debug_list_threads',
        description: '暂停时列出当前调试程序的线程。',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_select_thread',
        description: '切换此 MCP 端点的当前线程。需要当前 pauseId。注意：VSCode 未公开程序化切换 UI 线程焦点的 API，此操作仅更新内部状态，不改变 VSCode 界面的线程选择。',
        inputSchema: {
            type: 'object',
            properties: {
                threadId: { type: 'integer', minimum: 1 },
                expectedPauseId: { type: 'string' }
            },
            required: ['threadId', 'expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_select_frame',
        description: '切换此 MCP 端点的当前栈帧。需要当前 pauseId。注意：VSCode 未公开程序化切换 UI 栈帧焦点的 API，此操作仅更新内部状态，不改变 VSCode 界面的栈帧选择。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0 },
                expectedPauseId: { type: 'string' }
            },
            required: ['frameIndex', 'expectedPauseId'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_get_frame_locals',
        description: '读取指定栈帧（或省略 frameIndex 时读取当前帧）的参数和局部变量，不改变 VSCode 选择。可按名过滤以实现最小权限读取。凭据值会被自动脱敏。（合并了原 debug_get_locals）',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0, description: '可选。省略时使用当前帧。' },
                maxDepth: { type: 'integer', minimum: 0, maximum: 4, default: 1 },
                maxItems: { type: 'integer', minimum: 1, maximum: 500, default: 100, description: '整个返回树共享的总节点预算' },
                names: { type: 'array', items: { type: 'string' }, description: '可选变量名白名单，仅返回这些变量。先用 debug_list_variable_names 枚举。' },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_list_variable_names',
        description: '仅枚举指定栈帧的变量名和类型，不读取值。用于最小权限模型：先枚举名称，再用 debug_get_frame_locals 的 names 过滤按需取值。凭据值不会在此泄漏。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0 },
                expectedPauseId: { type: 'string' }
            },
            required: ['frameIndex'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_get_variables_by_name',
        description: '按变量名精确读取指定栈帧的变量值（最小权限读取）。最多 50 个变量名，仅返回匹配的变量，凭据值自动脱敏。适合 AI 只需读取特定变量而非全部局部变量的场景。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0, description: '可选。省略时使用当前帧。' },
                names: { type: 'array', items: { type: 'string' }, maxItems: 50, description: '要读取的变量名列表（最多 50 个）。' },
                maxDepth: { type: 'integer', minimum: 0, maximum: 4, default: 1 },
                expectedPauseId: { type: 'string' }
            },
            required: ['names'],
            additionalProperties: false
        }
    },
    // ═══ 27. debug_get_current_frame → 已合并到 debug_get_call_stack ═══
    {
        name: 'debug_get_call_stack',
        description: '暂停时读取当前线程的调用栈，同时返回 currentFrame 和 currentFrameIndex。（合并了原 debug_get_current_frame）',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_get_source_context',
        description: '读取栈帧当前语句周围的源代码行，优先使用未保存的编辑器缓冲区。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0 },
                linesBefore: { type: 'integer', minimum: 0, maximum: 199, default: 30 },
                linesAfter: { type: 'integer', minimum: 0, maximum: 199, default: 30 },
                preferEditorBuffer: { type: 'boolean', default: true },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_capture_pause_context',
        description: '在一个 pauseId 下捕获停止原因、进程、线程、调用栈、源码、局部变量、参数和匹配断点。',
        inputSchema: {
            type: 'object',
            properties: {
                stackLimit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
                linesBefore: { type: 'integer', minimum: 0, maximum: 199, default: 30 },
                linesAfter: { type: 'integer', minimum: 0, maximum: 199, default: 30 },
                maxDepth: { type: 'integer', minimum: 0, maximum: 4, default: 1 },
                maxItems: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
                preferEditorBuffer: { type: 'boolean', default: true },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },
    // ═══ 31. debug_get_locals → 已合并到 debug_get_frame_locals ═══
    {
        name: 'debug_evaluate',
        description: '在当前帧中求值调试器表达式。除非增加 maxDepth，否则仅返回根值。',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string' },
                timeoutMs: { type: 'integer', minimum: 100, maximum: 30000, default: 3000 },
                maxDepth: { type: 'integer', minimum: 0, maximum: 4, default: 0 },
                maxItems: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
                expectedPauseId: { type: 'string' }
            },
            required: ['expression'],
            additionalProperties: false
        }
    },

    // ═══ 暂停捕获（实验性） ═══
    {
        name: 'debug_get_pause_capture_status',
        description: '实验性。读取暂停捕获功能状态、激活状态、watch 和 snapshot 计数，以及用户配置的有效限制。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'debug_set_pause_capture_active',
        description: '实验性。为此 VSCode 进程激活或停用暂停捕获。需要预期工作区路径。',
        inputSchema: {
            type: 'object',
            properties: {
                active: { type: 'boolean' },
                expectedSolution: { type: 'string', description: '必需的绝对工作区路径' }
            },
            required: ['active', 'expectedSolution'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_add_capture_watch',
        description: '实验性。添加一个在每次暂停时首先捕获的 watch 表达式。返回分配的 watchId 和有效的用户限制预算。',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: '在暂停捕获时求值的调试器表达式' },
                function: { type: 'string', description: '可选栈帧函数子串。省略则在当前帧求值。' },
                maxDepth: { type: 'integer', minimum: 0, maximum: 2, default: 1, description: '请求的展开深度。用户配置的限制优先。' },
                maxItems: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: '请求的节点预算。用户配置的限制优先。' }
            },
            required: ['expression'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_list_capture_watches',
        description: '实验性。列出已配置的捕获 watch。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
        name: 'debug_remove_capture_watch',
        description: '实验性。通过 watchId 移除一个捕获 watch。',
        inputSchema: {
            type: 'object',
            properties: {
                watchId: { type: 'string' }
            },
            required: ['watchId'],
            additionalProperties: false
        }
    },
    // ═══ 38. debug_get_latest_pause_capture → 已合并到 debug_get_pause_capture ═══
    {
        name: 'debug_list_pause_captures',
        description: '实验性。列出已存储的暂停捕获元数据（不含负载体）。',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_get_pause_capture',
        description: '实验性。通过 captureId 读取一个已存储的暂停捕获。省略 captureId 时返回最新捕获（合并了原 debug_get_latest_pause_capture）。',
        inputSchema: {
            type: 'object',
            properties: {
                captureId: { type: 'string', description: '可选。省略时返回最新捕获。' }
            },
            additionalProperties: false
        }
    },
    {
        name: 'debug_clear_pause_captures',
        description: '实验性。清除所有已存储的暂停捕获。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },

    // ═══ 数据断点 ═══
    {
        name: 'debug_add_data_breakpoint',
        description: '添加数据断点，在内存地址被写入时触发。需要当前 pauseId。注意：VSCode DAP 协议不支持字节级监视宽度，dataCount 参数仅作记录，实际监视粒度由调试适配器决定。',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: '可寻址表达式，例如 ptr->Member 或 object.field' },
                dataCount: { type: 'integer', minimum: 1, maximum: 8, default: 4, description: '监视的字节数' },
                expectedPauseId: { type: 'string' }
            },
            required: ['expression'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_manage_breakpoint_by_tag',
        description: '通过返回的 tag 启用、禁用或移除一个 MCP 管理的数据断点。',
        inputSchema: {
            type: 'object',
            properties: {
                tag: { type: 'string' },
                action: { type: 'string', enum: ['enable', 'disable', 'remove'] }
            },
            required: ['tag', 'action'],
            additionalProperties: false
        }
    },

    // ═══ 模块 ═══
    {
        name: 'debug_list_modules',
        description: '列出调试会话已加载的源文件（近似模块列表）。注意：VSCode DAP 无标准 modules 请求，此工具返回的是 loadedSources 源文件列表而非带基址的原生模块，符号状态与优化状态信息可能缺失。',
        inputSchema: {
            type: 'object',
            properties: {
                nameFilter: { type: 'string' },
                nativeOnly: { type: 'boolean', default: true, description: '优先原生、已优化或无符号模块' },
                limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
            },
            additionalProperties: false
        }
    },

    // ═══ 反汇编 ═══
    {
        name: 'debug_get_disassembly',
        description: '读取当前或选定栈帧周围的反汇编，带源码行标注。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0, default: 0 },
                instructionCount: { type: 'integer', minimum: 10, maximum: 200, default: 50, description: '返回的最大指令数' },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },

    // ═══ 寄存器 ═══
    {
        name: 'debug_get_registers',
        description: '从当前或选定栈帧读取 CPU 寄存器。注意：依赖非标准 DAP registers 请求，多数调试适配器不支持，可能返回空组。',
        inputSchema: {
            type: 'object',
            properties: {
                frameIndex: { type: 'integer', minimum: 0, default: 0 },
                expectedPauseId: { type: 'string' }
            },
            additionalProperties: false
        }
    },

    // ═══ 内存 ═══
    {
        name: 'debug_read_memory',
        description: '通过求值可寻址表达式读取一小块原始内存。',
        inputSchema: {
            type: 'object',
            properties: {
                expression: { type: 'string', description: '可寻址表达式或指针表达式' },
                byteCount: { type: 'integer', minimum: 16, maximum: 256, default: 64, description: '读取的字节数' },
                bytesPerRow: { type: 'integer', minimum: 8, maximum: 32, default: 16, description: '每行显示的字节数' },
                frameIndex: { type: 'integer', minimum: 0, default: 0 },
                expectedPauseId: { type: 'string' }
            },
            required: ['expression'],
            additionalProperties: false
        }
    },

    // ═══ 源码映射 ═══
    {
        name: 'debug_set_source_map',
        description: '为此 VSCode 进程生命周期映射编译时源码根到本地源码根。',
        inputSchema: {
            type: 'object',
            properties: {
                mappings: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            from: { type: 'string' },
                            to: { type: 'string' }
                        },
                        required: ['from', 'to']
                    }
                },
                replace: { type: 'boolean', default: true }
            },
            required: ['mappings'],
            additionalProperties: false
        }
    },
    {
        name: 'debug_list_source_maps',
        description: '列出为此 VSCode 进程配置的源码路径映射。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
];

/** 工具名 → 定义映射 */
export const ToolMap: Record<string, McpTool> = Object.fromEntries(
    ToolDefinitions.map(t => [t.name, t])
);
