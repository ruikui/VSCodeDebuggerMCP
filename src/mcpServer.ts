import * as http from 'http';
import { DebuggerService } from './debuggerService';
import { ToolDefinitions, ToolMap } from './toolDefinitions';
import { JsonRpcRequest, JsonRpcResponse } from './types';

/**
 * MCP HTTP 服务器：手写 HTTP + JSON-RPC 2.0，实现 MCP 协议核心方法。
 * 仅监听 127.0.0.1，不接受外部连接。
 *
 * 多窗口架构：后端监听随机端口，向 Broker 注册，Broker 按 instanceId 路由。
 * Host/Origin 头校验防 DNS-rebinding。
 */

/** 允许的 Host 头值（防 DNS-rebinding）。仅允许本地回环地址。 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class McpServer {
    private readonly _server: http.Server;
    private readonly _debugger: DebuggerService;
    private _port: number;
    private _running = false;
    private _log: string[] = [];
    private readonly _maxLogEntries = 200;
    private _toolChain: Promise<unknown> = Promise.resolve();
    private readonly _instanceId: string;
    private readonly _brokerPort?: number;
    private _heartbeatTimer: NodeJS.Timeout | null = null;
    private _registered = false;

    constructor(debuggerService: DebuggerService, port: number, instanceId?: string, brokerPort?: number) {
        this._debugger = debuggerService;
        this._port = port;
        this._instanceId = instanceId ?? debuggerService.getDebugStatus().instanceId;
        this._brokerPort = brokerPort;
        this._server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    get port(): number { return this._port; }
    get endpoint(): string { return `http://127.0.0.1:${this._port}/mcp/`; }
    get isRunning(): boolean { return this._running; }
    get instanceId(): string { return this._instanceId; }
    get isRegistered(): boolean { return this._registered; }

    /** Broker 路由状态（供 debug_get_broker_status 工具调用）。 */
    getBrokerStatus(): object {
        return {
            instanceId: this._instanceId,
            // endpoint 始终是客户端应连接的地址；Broker 模式下是 Broker 端口，直连模式下是后端本身。
            endpoint: this._brokerPort ? `http://127.0.0.1:${this._brokerPort}/mcp/` : this.endpoint,
            backendEndpoint: this.endpoint,
            backendPort: this._port,
            brokerPort: this._brokerPort ?? null,
            registered: this._registered,
            running: this._running
        };
    }

    /** 列出 Broker 注册的所有实例（供 debug_list_instances 工具调用）。 */
    async listInstances(): Promise<object> {
        if (!this._brokerPort) {
            return { brokerEnabled: false, instances: [{ instanceId: this._instanceId, port: this._port }] };
        }
        return new Promise((resolve) => {
            const endpoint = `http://127.0.0.1:${this._brokerPort}/mcp/`;
            const req = http.request({
                hostname: '127.0.0.1',
                port: this._brokerPort,
                path: '/instances',
                method: 'GET',
                timeout: 2000
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        const body = JSON.parse(data);
                        resolve({ brokerEnabled: true, brokerPort: this._brokerPort, endpoint, ...body });
                    } catch {
                        resolve({ brokerEnabled: true, brokerPort: this._brokerPort, endpoint, instances: [], error: 'Invalid response' });
                    }
                });
            });
            req.on('error', (e) => {
                resolve({ brokerEnabled: true, brokerPort: this._brokerPort, endpoint, instances: [], error: e.message });
            });
            req.on('timeout', () => { req.destroy(); resolve({ brokerEnabled: true, brokerPort: this._brokerPort, endpoint, instances: [], error: 'timeout' }); });
            req.end();
        });
    }

    async start(): Promise<boolean> {
        if (this._running) return true;
        return new Promise((resolve) => {
            // 有 Broker 时监听随机端口（0=OS 分配），否则监听配置端口（向后兼容）
            const listenPort = this._brokerPort ? 0 : this._port;
            this._registered = false;
            this._server.listen(listenPort, '127.0.0.1', () => {
                this._running = true;
                const addr = this._server.address();
                if (typeof addr === 'object' && addr) {
                    this._port = addr.port;
                }
                this.log(`MCP server started on port ${this._port} (instanceId=${this._instanceId})`);
                // 向 Broker 注册（若配置了 brokerPort）。Broker 可能尚未监听，注册自带重试；
                // 心跳定时器也会在未注册时继续补注册。
                if (this._brokerPort) {
                    void this.registerWithBrokerWithRetry();
                    this.startHeartbeat();
                }
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
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
        if (this._registered) {
            await this.unregisterFromBroker().catch(() => {});
            this._registered = false;
        }
        if (!this._running) return;
        return new Promise((resolve) => {
            this._server.close(() => {
                this._running = false;
                this.log('MCP server stopped');
                resolve();
            });
        });
    }

    /** 向 Broker 注册，失败时重试：Broker 进程可能尚未完成监听。 */
    private async registerWithBrokerWithRetry(attempts = 5, delayMs = 300, quiet = false): Promise<boolean> {
        for (let attempt = 0; attempt < attempts; attempt++) {
            if (await this.registerWithBroker(quiet)) return true;
            if (attempt < attempts - 1) {
                await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
        }
        return false;
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
        // 安全：Host 头校验（防 DNS-rebinding）
        if (!this.isHostAllowed(req.headers.host)) {
            this.sendJson(res, 403, { error: 'Host header not allowed' });
            return;
        }
        // 安全：Origin 头校验（若存在必须指向本地回环，非浏览器跨域）
        if (!this.isOriginAllowed(req.headers.origin)) {
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

    // ── 安全校验 ──

    /** 从 Host 头提取 hostname（去掉端口），兼容 IPv6 [::1]:port。 */
    private extractHostname(host: string): string {
        if (host.startsWith('[')) {
            const end = host.indexOf(']');
            return end > 0 ? host.slice(1, end) : host;
        }
        const colon = host.indexOf(':');
        return colon > 0 ? host.slice(0, colon) : host;
    }

    /** 校验 Host 头是否指向本地回环，防 DNS-rebinding 攻击。 */
    private isHostAllowed(host: string | undefined): boolean {
        if (!host) return false;
        return ALLOWED_HOSTS.has(this.extractHostname(host));
    }

    /** 校验 Origin 头：若存在，必须指向本地回环（非浏览器跨域）。 */
    private isOriginAllowed(origin: string | undefined): boolean {
        if (!origin) return true; // 无 Origin 头（非浏览器请求）放行
        try {
            const u = new URL(origin);
            return ALLOWED_HOSTS.has(u.hostname);
        } catch {
            return false;
        }
    }

    // ── Broker 注册 ──

    private async registerWithBroker(quiet = false): Promise<boolean> {
        if (!this._brokerPort) return false;
        return new Promise((resolve) => {
            const body = JSON.stringify({ instanceId: this._instanceId, port: this._port });
            const req = http.request({
                hostname: '127.0.0.1',
                port: this._brokerPort,
                path: '/register',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    if (res.statusCode === 200) {
                        this._registered = true;
                        this.log(`Registered with broker on port ${this._brokerPort}`);
                        resolve(true);
                    } else {
                        if (!quiet) this.log(`Broker registration failed: ${res.statusCode} ${data}`);
                        resolve(false);
                    }
                });
            });
            req.on('error', (e) => {
                if (!quiet) this.log(`Broker registration error: ${e.message}`);
                resolve(false);
            });
            req.end(body);
        });
    }

    private async unregisterFromBroker(): Promise<boolean> {
        if (!this._brokerPort) return false;
        return new Promise((resolve) => {
            const body = JSON.stringify({ instanceId: this._instanceId });
            const req = http.request({
                hostname: '127.0.0.1',
                port: this._brokerPort,
                path: '/unregister',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                res.on('end', () => {
                    this._registered = false;
                    resolve(true);
                });
            });
            req.on('error', () => resolve(false));
            req.end(body);
        });
    }

    private startHeartbeat(): void {
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
        this._heartbeatTimer = setInterval(() => {
            if (!this._brokerPort) return;
            // 失联或漏注册时，下一拍先补注册；成功后恢复心跳。
            if (!this._registered) {
                void this.registerWithBrokerWithRetry(1, 0, true);
                return;
            }
            const body = JSON.stringify({ instanceId: this._instanceId });
            const req = http.request({
                hostname: '127.0.0.1',
                port: this._brokerPort,
                path: '/heartbeat',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            }, (res) => {
                res.resume();
                if (res.statusCode !== 200) this._registered = false;
            });
            req.on('error', () => { this._registered = false; });
            req.end(body);
        }, 10000); // 10s 心跳
        this._heartbeatTimer.unref();
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

        // 串行化工具调用：避免并发修改共享调试状态产生竞态。
        // debug_wait_for_pause 是长轮询且不修改共享状态，直接并发执行，避免阻塞后续调用（如 pause/stop 无法打断等待）。
        const serialized = toolName !== 'debug_wait_for_pause';
        const task = serialized
            ? this._toolChain.then(() => this.dispatchToolCall(toolName, args))
            : this.dispatchToolCall(toolName, args);
        if (serialized) this._toolChain = task.then(() => undefined, () => undefined);

        try {
            const result = await task;
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

    // ── 工具分发（44 个工具，合并精简后）──

    private async dispatchToolCall(name: string, args: any): Promise<any> {
        const dbg = this._debugger;
        const fo = dbg.frames;
        const pc = dbg.pauseCapture;
        const adv = dbg.advanced;

        switch (name) {
            // ═══ 实例与状态 ═══
            case 'debug_get_status':
                return dbg.getDebugStatus(args.expectedPauseId);
            case 'debug_get_broker_status':
                return this.getBrokerStatus();
            case 'debug_list_instances':
                return this.listInstances();
            case 'debug_list_processes':
                return dbg.listProcesses(args.nameFilter, args.limit);
            case 'debug_verify_target':
                return dbg.verifyTarget(args);
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
            case 'debug_add_logpoint':
                return dbg.addLogpoint(args);
            case 'debug_list_breakpoints':
                return dbg.listBreakpoints();
            case 'debug_set_breakpoint_enabled':
                return dbg.setBreakpointEnabled(args);
            case 'debug_remove_breakpoint':
                return dbg.removeBreakpoint(args);
            case 'debug_clear_all_breakpoints':
                return dbg.clearAllBreakpoints();

            // ═══ 执行控制 ═══
            case 'debug_start':
                return dbg.startDebugging(args);
            case 'debug_restart':
                return dbg.restartSession(args);
            case 'debug_continue':
                return dbg.continueExecution(args.expectedPauseId);
            case 'debug_pause':
                return dbg.pauseExecution(args.processId);
            case 'debug_step_into':
                return dbg.step('into', args.expectedPauseId);
            case 'debug_step_over':
                return dbg.step('over', args.expectedPauseId);
            case 'debug_step_out':
                return dbg.step('out', args.expectedPauseId);
            case 'debug_stop':
                return dbg.stopDebugging(args.processId);
            case 'debug_wait_for_pause':
                return dbg.waitForPause(args.timeoutMs);
            case 'debug_start_test':
                return dbg.startTest(args);

            // ═══ 线程与栈帧 ═══
            case 'debug_list_threads':
                return fo.listThreads(args.limit, args.expectedPauseId);
            case 'debug_select_thread':
                return fo.selectThread(args.threadId, args.expectedPauseId);
            case 'debug_select_frame':
                return fo.selectFrame(args.frameIndex, args.expectedPauseId);
            case 'debug_get_frame_locals':
                return fo.getFrameLocals(args.frameIndex, args.maxDepth, args.maxItems, args.expectedPauseId, args.names);
            case 'debug_list_variable_names':
                return fo.listVariableNames(args.frameIndex, args.expectedPauseId);
            case 'debug_get_variables_by_name':
                return fo.getVariablesByName(args.frameIndex, args.names, args.maxDepth, args.expectedPauseId);
            // ═══ 27. debug_get_current_frame → 已合并到 debug_get_call_stack ═══
            case 'debug_get_call_stack':
                return fo.getCallStack(args.limit, args.expectedPauseId);
            case 'debug_get_source_context':
                return fo.getSourceContext(args);
            case 'debug_capture_pause_context':
                return fo.capturePauseContext(args);
            // ═══ 31. debug_get_locals → 已合并到 debug_get_frame_locals ═══
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
            // ═══ 38. debug_get_latest_pause_capture → 已合并到 debug_get_pause_capture ═══
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
