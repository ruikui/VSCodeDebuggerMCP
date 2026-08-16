import * as http from 'http';
import * as vscode from 'vscode';
import { DebuggerService } from './debuggerService';
import { ToolDefinitions, ToolMap } from './toolDefinitions';
import { JsonRpcRequest, JsonRpcResponse } from './types';

/**
 * MCP HTTP 服务器：手写 HTTP + JSON-RPC 2.0，实现 MCP 协议核心方法。
 * 仅监听 127.0.0.1，不接受外部连接。
 */
export class McpServer {
    private readonly _server: http.Server;
    private readonly _debugger: DebuggerService;
    private _port: number;
    private _running = false;
    private _initialized = false;
    private _log: string[] = [];
    private readonly _maxLogEntries = 200;

    constructor(debuggerService: DebuggerService, port: number) {
        this._debugger = debuggerService;
        this._port = port;
        this._server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    get port(): number { return this._port; }
    get endpoint(): string { return `http://127.0.0.1:${this._port}/mcp/`; }
    get isRunning(): boolean { return this._running; }

    async start(): Promise<boolean> {
        return new Promise((resolve) => {
            this._server.listen(this._port, '127.0.0.1', () => {
                this._running = true;
                this.log(`MCP server started on port ${this._port}`);
                resolve(true);
            });
            this._server.on('error', (err: NodeJS.ErrnoException) => {
                this._running = false;
                this.log(`MCP server failed to start: ${err.message}`);
                resolve(false);
            });
        });
    }

    async stop(): Promise<void> {
        if (!this._running) return;
        return new Promise((resolve) => {
            this._server.close(() => {
                this._running = false;
                this.log('MCP server stopped');
                resolve();
            });
        });
    }

    async restart(newPort?: number): Promise<boolean> {
        await this.stop();
        if (newPort) this._port = newPort;
        return this.start();
    }

    getLog(): string[] {
        return [...this._log];
    }

    private log(message: string) {
        const entry = `[${new Date().toISOString()}] ${message}`;
        this._log.push(entry);
        if (this._log.length > this._maxLogEntries) {
            this._log.shift();
        }
    }

    // ── HTTP 请求处理 ──

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // 安全：拒绝浏览器跨域请求
        const origin = req.headers.origin;
        if (origin && req.method === 'POST') {
            this.sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
            return;
        }
        if (req.method === 'OPTIONS') {
            this.sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
            return;
        }

        const url = (req.url ?? '').split('?')[0];

        // 健康检查
        if (url === '/health' && req.method === 'GET') {
            this.sendJson(res, 200, {
                mcp: true,
                name: 'VSCode Debugger MCP',
                version: '1.0.0',
                port: this._port,
                running: this._running
            });
            return;
        }

        // MCP 端点
        if ((url === '/mcp' || url === '/mcp/') && req.method === 'POST') {
            try {
                const body = await this.readBody(req);
                const request = JSON.parse(body) as JsonRpcRequest;
                const response = await this.handleJsonRpc(request);
                this.sendJson(res, 200, response);
            } catch (e: any) {
                this.sendJson(res, 200, {
                    jsonrpc: '2.0',
                    id: null,
                    error: { code: -32700, message: `Parse error: ${e.message}` }
                } as JsonRpcResponse);
            }
            return;
        }

        // 未知路径
        this.sendJson(res, 404, { error: 'Not found' });
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => {
                data += chunk;
                if (data.length > 10 * 1024 * 1024) {
                    reject(new Error('Request body too large'));
                }
            });
            req.on('end', () => resolve(data));
            req.on('error', reject);
        });
    }

    private sendJson(res: http.ServerResponse, status: number, body: object) {
        const json = JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(json)
        });
        res.end(json);
    }

    // ── JSON-RPC 处理 ──

    private async handleJsonRpc(request: JsonRpcRequest): Promise<JsonRpcResponse> {
        const { id, method, params } = request;

        try {
            switch (method) {
                case 'initialize':
                    return this.handleInitialize(id, params);

                case 'ping':
                    return this.makeResult(id, {});

                case 'tools/list':
                    return this.handleToolsList(id);

                case 'tools/call':
                    return this.handleToolsCall(id, params);

                case 'resources/list':
                    return this.makeResult(id, { resources: [] });

                case 'prompts/list':
                    return this.makeResult(id, { prompts: [] });

                default:
                    return this.makeError(id, -32601, `Method not found: ${method}`);
            }
        } catch (e: any) {
            return this.makeError(id, -32603, `Internal error: ${e.message}`);
        }
    }

    private handleInitialize(id: string | number | null, params?: any): JsonRpcResponse {
        this._initialized = true;
        const protocolVersion = params?.protocolVersion ?? '2024-11-05';
        return this.makeResult(id, {
            protocolVersion,
            capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false },
                prompts: { listChanged: false }
            },
            serverInfo: {
                name: 'VSCode Debugger MCP',
                version: '1.0.0'
            }
        });
    }

    private handleToolsList(id: string | number | null): JsonRpcResponse {
        return this.makeResult(id, {
            tools: ToolDefinitions.map(t => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema
            }))
        });
    }

    private async handleToolsCall(id: string | number | null, params?: any): Promise<JsonRpcResponse> {
        const toolName = params?.name;
        const args = params?.arguments ?? {};

        if (!toolName || !ToolMap[toolName]) {
            return this.makeError(id, -32602, `Unknown tool: ${toolName}`);
        }

        try {
            const result = await this.dispatchToolCall(toolName, args);
            return this.makeResult(id, {
                content: [{
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
                }]
            });
        } catch (e: any) {
            return this.makeResult(id, {
                content: [{
                    type: 'text',
                    text: `Error: ${e.message}`
                }],
                isError: true
            });
        }
    }

    // ── 工具分发（49 个工具）──

    private async dispatchToolCall(name: string, args: any): Promise<any> {
        const dbg = this._debugger;
        const fo = dbg.frames;
        const pc = dbg.pauseCapture;
        const adv = dbg.advanced;

        switch (name) {
            // ═══ 实例与状态 ═══
            case 'debug_get_status':
                return dbg.getDebugStatus();
            case 'debug_get_instance_info':
                return dbg.getInstanceInfo();
            case 'debug_list_processes':
                return dbg.listProcesses(args.nameFilter, args.limit);
            case 'debug_verify_target':
                return dbg.verifyTarget(args.processId, args.expectedExecutable, args.expectedSolution);
            case 'debug_attach_process':
                return dbg.attachProcess(args);
            case 'debug_launch_and_attach':
                return dbg.launchAndAttach(args);
            case 'debug_detach_process':
                return dbg.detachProcess(args.processId);
            case 'debug_select_process':
                return dbg.selectProcess(args.processId);

            // ═══ 断点 ═══
            case 'debug_add_breakpoint':
                return dbg.addBreakpoint(args);
            case 'debug_list_breakpoints':
                return dbg.listBreakpoints();
            case 'debug_set_breakpoint_enabled':
                return dbg.setBreakpointEnabled(args);
            case 'debug_remove_breakpoint':
                return dbg.removeBreakpoint(args);

            // ═══ 执行控制 ═══
            case 'debug_start':
                return dbg.startDebugging(args);
            case 'debug_restart':
                return dbg.restartSession(args);
            case 'debug_continue':
                return dbg.continueExecution(args.expectedPauseId);
            case 'debug_pause':
                return dbg.pauseExecution(args.processId);
            case 'debug_step_over':
                return dbg.stepOver(args.expectedPauseId);
            case 'debug_step_into':
                return dbg.stepInto(args.expectedPauseId);
            case 'debug_step_out':
                return dbg.stepOut(args.expectedPauseId);
            case 'debug_stop':
                return dbg.stopDebugging(args.processId);
            case 'debug_wait_for_pause':
                return dbg.waitForPause(args.timeoutMs, args.pollIntervalMs);
            case 'debug_get_stop_reason':
                return dbg.getStopReason(args.expectedPauseId);

            // ═══ 线程与栈帧 ═══
            case 'debug_list_threads':
                return fo.listThreads(args.limit, args.expectedPauseId);
            case 'debug_select_thread':
                return fo.selectThread(args.threadId, args.expectedPauseId);
            case 'debug_select_frame':
                return fo.selectFrame(args.frameIndex, args.expectedPauseId);
            case 'debug_get_frame_locals':
                return fo.getFrameLocals(args.frameIndex, args.maxDepth, args.maxItems, args.expectedPauseId);
            case 'debug_get_current_frame':
                return fo.getCurrentFrame(args.expectedPauseId);
            case 'debug_get_call_stack':
                return fo.getCallStack(args.limit, args.expectedPauseId);
            case 'debug_get_source_context':
                return fo.getSourceContext(args);
            case 'debug_capture_pause_context':
                return fo.capturePauseContext(args);
            case 'debug_get_locals':
                return fo.getLocals(args.maxDepth, args.maxItems, args.expectedPauseId);
            case 'debug_evaluate':
                return fo.evaluate(args);

            // ═══ 暂停捕获 ═══
            case 'debug_get_pause_capture_status':
                return pc.getStatus();
            case 'debug_set_pause_capture_active':
                return pc.setActive(args.active, args.expectedSolution);
            case 'debug_add_capture_watch':
                return pc.addWatch(args);
            case 'debug_list_capture_watches':
                return pc.listWatches();
            case 'debug_remove_capture_watch':
                return pc.removeWatch(args.watchId);
            case 'debug_get_latest_pause_capture':
                return pc.getLatest();
            case 'debug_list_pause_captures':
                return pc.listCaptures(args.limit);
            case 'debug_get_pause_capture':
                return pc.getCapture(args.captureId);
            case 'debug_clear_pause_captures':
                return pc.clear();

            // ═══ 数据断点 ═══
            case 'debug_add_data_breakpoint':
                return adv.addDataBreakpoint(args);
            case 'debug_manage_breakpoint_by_tag':
                return adv.manageByTag(args);

            // ═══ 模块 ═══
            case 'debug_list_modules':
                return adv.listModules(args);

            // ═══ 反汇编 ═══
            case 'debug_get_disassembly':
                return adv.getDisassembly(args);

            // ═══ 寄存器 ═══
            case 'debug_get_registers':
                return adv.getRegisters(args);

            // ═══ 内存 ═══
            case 'debug_read_memory':
                return adv.readMemory(args);

            // ═══ 源码映射 ═══
            case 'debug_set_source_map':
                return adv.setSourceMap(args);
            case 'debug_list_source_maps':
                return adv.listSourceMaps();

            default:
                throw new Error(`Tool not implemented: ${name}`);
        }
    }

    // ── JSON-RPC 辅助 ──

    private makeResult(id: string | number | null, result: object): JsonRpcResponse {
        return { jsonrpc: '2.0', id, result };
    }

    private makeError(id: string | number | null, code: number, message: string): JsonRpcResponse {
        return { jsonrpc: '2.0', id, error: { code, message } };
    }
}
