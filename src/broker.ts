import * as http from 'http';

/**
 * Broker 多窗口路由进程。
 *
 * 解决问题：CodeBuddy 多开 VSCode 窗口时，每个窗口的 MCP 后端都绑定
 * 同一公共端口会导致冲突。Broker 作为独立进程绑定公共端口，各窗口
 * 后端监听随机端口并向 Broker 注册，Broker 按 instanceId 路由请求。
 *
 * 生命周期：
 * - 首个窗口 fork 本进程，绑定公共端口
 * - 各窗口后端启动后 POST /register 注册，并定期 POST /heartbeat
 * - 所有实例注销后（空闲超时）本进程自动退出
 */

/** 允许的 Host 头值（防 DNS-rebinding）。仅允许本地回环地址。 */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 从 Host 头提取 hostname（去掉端口），兼容 IPv6 [::1]:port 格式。 */
function extractHostname(host: string): string {
    if (host.startsWith('[')) {
        const end = host.indexOf(']');
        return end > 0 ? host.slice(1, end) : host;
    }
    const colon = host.indexOf(':');
    return colon > 0 ? host.slice(0, colon) : host;
}

/** 校验 Host 头是否指向本地回环，防 DNS-rebinding 攻击。 */
function isHostAllowed(host: string | undefined): boolean {
    if (!host) return false;
    return ALLOWED_HOSTS.has(extractHostname(host));
}

/** 校验 Origin 头：若存在，必须指向本地回环（非浏览器跨域）。 */
function isOriginAllowed(origin: string | undefined): boolean {
    if (!origin) return true; // 无 Origin 头（非浏览器请求）放行
    try {
        const u = new URL(origin);
        return ALLOWED_HOSTS.has(u.hostname);
    } catch {
        return false;
    }
}

interface InstanceRecord {
    instanceId: string;
    port: number;
    lastSeen: number;
}

export class Broker {
    private readonly _server: http.Server;
    private _port: number;
    private _running = false;
    private _instances: Map<string, InstanceRecord> = new Map();
    private _idleTimer: NodeJS.Timeout | null = null;
    private readonly _idleTimeoutMs: number;
    private readonly _instanceTtlMs = 30000; // 30s 无心跳视为失联

    constructor(port: number, idleTimeoutMs = 60000) {
        this._port = port;
        this._idleTimeoutMs = idleTimeoutMs;
        this._server = http.createServer((req, res) => this.handleRequest(req, res));
    }

    get port(): number { return this._port; }
    get isRunning(): boolean { return this._running; }
    get instanceCount(): number { return this._instances.size; }

    async start(): Promise<boolean> {
        return new Promise((resolve) => {
            this._server.listen(this._port, '127.0.0.1', () => {
                this._running = true;
                const addr = this._server.address();
                if (typeof addr === 'object' && addr) {
                    this._port = addr.port;
                }
                this.resetIdleTimer();
                resolve(true);
            });
            this._server.on('error', () => {
                this._running = false;
                resolve(false);
            });
        });
    }

    async stop(): Promise<void> {
        if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
        if (!this._running) return;
        return new Promise((resolve) => {
            this._server.close(() => { this._running = false; resolve(); });
        });
    }

    private resetIdleTimer(): void {
        if (this._idleTimer) clearTimeout(this._idleTimer);
        this._idleTimer = setTimeout(() => {
            if (this._instances.size === 0) {
                this.stop().catch(() => {});
                process.exit(0);
            } else {
                this.resetIdleTimer();
            }
        }, this._idleTimeoutMs);
        this._idleTimer.unref();
    }

    private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        // 安全：Host 头校验（防 DNS-rebinding）
        if (!isHostAllowed(req.headers.host)) {
            this.sendJson(res, 403, { error: 'Host header not allowed' });
            return;
        }
        // 安全：Origin 头校验（若存在必须指向本地回环）
        if (!isOriginAllowed(req.headers.origin)) {
            this.sendJson(res, 403, { error: 'Cross-origin requests are not allowed' });
            return;
        }

        const url = (req.url ?? '').split('?')[0];

        // 健康检查
        if (url === '/health' && req.method === 'GET') {
            this.sendJson(res, 200, {
                broker: true, port: this._port,
                instances: this._instances.size
            });
            return;
        }

        // 实例注册
        if (url === '/register' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this.readBody(req));
                const { instanceId, port } = body;
                if (!instanceId || typeof port !== 'number') {
                    this.sendJson(res, 400, { error: 'instanceId and port required' });
                    return;
                }
                this._instances.set(instanceId, { instanceId, port, lastSeen: Date.now() });
                this.sendJson(res, 200, { registered: true, instanceId, brokerPort: this._port });
            } catch (e: any) {
                this.sendJson(res, 400, { error: `Invalid request: ${e.message}` });
            }
            return;
        }

        // 心跳
        if (url === '/heartbeat' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this.readBody(req));
                const rec = this._instances.get(body.instanceId);
                if (rec) { rec.lastSeen = Date.now(); this.sendJson(res, 200, { ok: true }); }
                else { this.sendJson(res, 404, { error: 'Instance not registered' }); }
            } catch (e: any) {
                this.sendJson(res, 400, { error: `Invalid request: ${e.message}` });
            }
            return;
        }

        // 注销
        if (url === '/unregister' && req.method === 'POST') {
            try {
                const body = JSON.parse(await this.readBody(req));
                this._instances.delete(body.instanceId);
                this.sendJson(res, 200, { unregistered: true });
            } catch (e: any) {
                this.sendJson(res, 400, { error: `Invalid request: ${e.message}` });
            }
            return;
        }

        // 列出实例
        if (url === '/instances' && req.method === 'GET') {
            this.purgeStale();
            this.sendJson(res, 200, {
                instances: Array.from(this._instances.values()).map(r => ({
                    instanceId: r.instanceId, port: r.port
                }))
            });
            return;
        }

        // MCP 路由：按 instanceId 转发到对应后端
        if ((url === '/mcp' || url === '/mcp/') && req.method === 'POST') {
            await this.proxyToInstance(req, res);
            return;
        }

        this.sendJson(res, 404, { error: 'Not found' });
    }

    private async proxyToInstance(req: http.IncomingMessage, res: http.ServerResponse) {
        // instanceId 可来自查询参数或 X-Instance-Id 头
        const url = req.url ?? '';
        const qIdx = url.indexOf('?');
        let instanceId: string | undefined;
        if (qIdx >= 0) {
            const params = new URLSearchParams(url.slice(qIdx + 1));
            instanceId = params.get('instanceId') ?? undefined;
        }
        if (!instanceId) instanceId = req.headers['x-instance-id'] as string | undefined;

        if (!instanceId) {
            this.sendJson(res, 400, { error: 'instanceId required (query param or X-Instance-Id header)' });
            return;
        }

        this.purgeStale();
        const rec = this._instances.get(instanceId);
        if (!rec) {
            this.sendJson(res, 404, { error: `Instance ${instanceId} not found` });
            return;
        }

        // 转发请求到后端
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);

        const proxyReq = http.request({
            hostname: '127.0.0.1',
            port: rec.port,
            path: '/mcp',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length }
        }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
            proxyRes.pipe(res);
        });
        proxyReq.on('error', (e) => {
            this.sendJson(res, 502, { error: `Backend unreachable: ${e.message}` });
        });
        proxyReq.end(body);
    }

    private purgeStale(): void {
        const now = Date.now();
        for (const [id, rec] of this._instances) {
            if (now - rec.lastSeen > this._instanceTtlMs) {
                this._instances.delete(id);
            }
        }
    }

    private readBody(req: http.IncomingMessage): Promise<string> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', (chunk) => {
                data += chunk;
                if (data.length > 1024 * 1024) reject(new Error('Body too large'));
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
}

// ── 作为独立进程运行时的入口 ──
if (require.main === module) {
    const port = parseInt(process.argv[2] ?? '37643', 10);
    const broker = new Broker(port);
    broker.start().then((ok) => {
        if (ok) {
            // 输出到 stderr，避免污染 stdout（stdout 留给可能的 IPC）
            process.stderr.write(`[broker] listening on 127.0.0.1:${port}\n`);
        } else {
            process.stderr.write(`[broker] failed to bind port ${port}\n`);
            process.exit(1);
        }
    });
    process.on('SIGTERM', () => { broker.stop().then(() => process.exit(0)); });
    process.on('SIGINT', () => { broker.stop().then(() => process.exit(0)); });
}
