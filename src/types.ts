/** MCP 工具定义 */
export interface McpTool {
    name: string;
    description: string;
    inputSchema: object;
}

/** 调试器状态 */
export type DebuggerState = 'running' | 'paused' | 'stopped' | 'starting';

/** 调试状态（合并了原 instance_info 和 stop_reason 的字段） */
export interface DebugStatus {
    // 实例信息（原 InstanceInfo）
    instanceId: string;
    ide: string;
    version: string;
    workspace: string;
    // 调试状态
    state: DebuggerState;
    hasActiveSession: boolean;
    sessionName: string | null;
    sessionType: string | null;
    processId: number | null;
    threadId: number | null;
    frameId: number | null;
    frameIndex: number | null;
    pauseId: string | null;
    stopReason: string | null;
    stale?: boolean;
}

/** 栈帧 */
export interface StackFrame {
    id: number;
    name: string;
    source: { path: string | null; name: string; sourceReference?: number } | null;
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
    moduleId?: string;
    presentationHint?: string;
    instructionPointerReference?: string;
}

/** 变量 */
export interface Variable {
    name: string;
    value: string;
    type: string | null;
    variablesReference: number;
    namedVariables?: number;
    indexedVariables?: number;
    evaluateName?: string;
    memoryReference?: string;
    presentationHint?: object;
}

/** 线程 */
export interface Thread {
    id: number;
    name: string;
}

/** 断点信息 */
export interface BreakpointInfo {
    id: string;
    type: 'source' | 'function' | 'data' | 'log';
    enabled: boolean;
    file: string | null;
    line: number | null;
    column: number | null;
    condition: string | null;
    hitCondition: string | null;
    logMessage: string | null;
    verified: boolean;
    message: string | null;
    tag: string | null;
}

/** 暂停上下文 */
export interface PauseContext {
    pauseId: string;
    reason: string;
    threadId: number;
    frame: StackFrame | null;
    callStack: StackFrame[];
    sourceContext: { file: string; startLine: number; endLine: number; lines: string[] } | null;
    locals: Variable[];
    arguments: Variable[];
    threads: Thread[];
    matchingBreakpoints: BreakpointInfo[];
}

/** ── 暂停捕获系统 ── */

export interface CaptureWatch {
    watchId: string;
    expression: string;
    function: string | null;
    maxDepth: number;
    maxItems: number;
}

export interface CaptureWatchResult {
    watchId: string;
    expression: string;
    value: string;
    type: string | null;
    error: string | null;
    children: Variable[];
}

export interface PauseCapture {
    captureId: string;
    pauseId: string;
    timestamp: string;
    reason: string;
    threadId: number;
    frame: StackFrame | null;
    callStack: StackFrame[];
    sourceContext: { file: string; startLine: number; endLine: number; lines: string[] } | null;
    locals: Variable[];
    arguments: Variable[];
    watches: CaptureWatchResult[];
    redacted?: boolean;
    redactionNotice?: string | null;
}

export interface PauseCaptureStatus {
    active: boolean;
    watchCount: number;
    captureCount: number;
    maxCaptures: number;
    defaultMaxDepth: number;
    defaultMaxItems: number;
}

export interface PauseCaptureMetadata {
    captureId: string;
    pauseId: string;
    timestamp: string;
    reason: string;
    threadId: number;
    frameName: string | null;
    frameFile: string | null;
    frameLine: number | null;
}

/** ── 数据断点 ── */

export interface DataBreakpointInfo {
    tag: string;
    expression: string;
    dataId: string | null;
    accessType: string;
    dataCount: number;
    enabled: boolean;
    verified: boolean;
    message: string | null;
}

/** ── 模块 ── */

export interface ModuleInfo {
    id: number;
    name: string;
    path: string | null;
    sourceReference: number;
    symbolStatus: string | null;
    isOptimized: boolean | null;
    isUserCode: boolean | null;
    version: string | null;
}

/** ── 反汇编 ── */

export interface DisassemblyInstruction {
    address: string;
    instruction: string;
    line: number | null;
    column: number | null;
    endLine: number | null;
    endColumn: number | null;
    symbol: string | null;
    sourceFile: string | null;
}

/** ── 寄存器 ── */

export interface RegisterGroup {
    name: string;
    registers: { name: string; value: string; memoryReference?: string }[];
}

/** ── 内存读取 ── */

export interface MemoryReadResult {
    address: string;
    byteCount: number;
    bytesPerRow: number;
    hex: string[];
    ascii: string[];
    raw: string;
}

/** ── 源码映射 ── */

export interface SourceMapEntry {
    from: string;
    to: string;
}

/** ── 进程信息 ── */

export interface ProcessInfo {
    pid: number;
    name: string;
    commandLine: string;
    executablePath: string | null;
}

/** ── MCP JSON-RPC ── */

export interface JsonRpcRequest {
    jsonrpc: string;
    id: string | number | null;
    method: string;
    params?: object;
}

export interface JsonRpcResponse {
    jsonrpc: string;
    id: string | number | null;
    result?: object;
    error?: { code: number; message: string; data?: object };
}

/** DAP 停止事件追踪 */
export interface DapStopEvent {
    reason: string;
    threadId: number;
    allThreadsStopped?: boolean;
    hitBreakpointIds?: number[];
}

/** DAP 终止事件 */
export interface DapTerminateEvent {
    restart?: boolean;
}
