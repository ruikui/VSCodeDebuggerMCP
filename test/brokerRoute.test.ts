/**
 * Broker 注册校验、心跳、MCP 路由转发测试。
 * 验证多窗口架构的核心：按 instanceId 将请求转发到正确后端。
 */
import * as http from 'http';
import { Broker } from '../src/broker';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) { console.log(`  [PASS] ${label}`); passed++; }
    else { console.error(`  [FAIL] ${label}`); failed++; }
}

interface HttpResult { status: number; body: string; }

function httpPost(port: number, path: string, body: object, headers: Record<string, string> = {}): Promise<HttpResult> {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
            timeout: 2000
        }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.end(data);
    });
}

function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<HttpResult> {
    return new Promise((resolve) => {
        const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET', headers, timeout: 2000 }, (res) => {
            let body = '';
            res.on('data', (c) => body += c);
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', () => resolve({ status: 0, body: '' }));
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
        req.end();
    });
}

/** 启动一个 mock 后端，记录收到的请求并回显 method。 */
function startMockBackend(): Promise<{ server: http.Server; port: number; getLastBody: () => any }> {
    return new Promise((resolve) => {
        let lastBody: any = null;
        const server = http.createServer((req, res) => {
            let data = '';
            req.on('data', (c) => data += c);
            req.on('end', () => {
                try { lastBody = JSON.parse(data || '{}'); } catch { lastBody = {}; }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jsonrpc: '2.0', id: lastBody?.id ?? null, result: { echoed: lastBody?.method ?? null } }));
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            resolve({ server, port, getLastBody: () => lastBody });
        });
    });
}

/** 保留一个空闲端口（先绑定再关闭），用于模拟不可达后端。 */
function reserveFreePort(): Promise<number> {
    return new Promise((resolve) => {
        const srv = http.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            srv.close(() => resolve(port));
        });
    });
}

async function testRegistrationValidation(): Promise<void> {
    console.log('\n  [组] 注册参数校验');
    const broker = new Broker(0);
    await broker.start();

    const empty = await httpPost(broker.port, '/register', {});
    assert(empty.status === 400, '空 body 注册被拒绝（400）');

    const noPort = await httpPost(broker.port, '/register', { instanceId: 'x' });
    assert(noPort.status === 400, '缺 port 注册被拒绝（400）');

    const badPort = await httpPost(broker.port, '/register', { instanceId: 'x', port: 'abc' });
    assert(badPort.status === 400, 'port 非 number 注册被拒绝（400）');

    assert(broker.instanceCount === 0, '非法注册未产生实例');

    await broker.stop();
}

async function testHeartbeat(): Promise<void> {
    console.log('\n  [组] 心跳');
    const broker = new Broker(0);
    await broker.start();

    const ghost = await httpPost(broker.port, '/heartbeat', { instanceId: 'ghost' });
    assert(ghost.status === 404, '未注册实例心跳返回 404');

    await httpPost(broker.port, '/register', { instanceId: 'inst-hb', port: 9999 });
    const ok = await httpPost(broker.port, '/heartbeat', { instanceId: 'inst-hb' });
    assert(ok.status === 200, '已注册实例心跳返回 200');
    assert(JSON.parse(ok.body).ok === true, '心跳响应 ok: true');

    await broker.stop();
}

async function testMCPRouting(): Promise<void> {
    console.log('\n  [组] MCP 路由转发');
    const broker = new Broker(0);
    await broker.start();

    // 0. 无实例时无法路由
    const noInstances = await httpPost(broker.port, '/mcp', { jsonrpc: '2.0', id: 0, method: 'debug_get_status' });
    assert(noInstances.status === 503, '无实例时 MCP 请求返回 503');

    const backend = await startMockBackend();
    await httpPost(broker.port, '/register', { instanceId: 'inst-a', port: backend.port });

    // 1. 查询参数路由
    const viaQuery = await httpPost(broker.port, '/mcp?instanceId=inst-a', { jsonrpc: '2.0', id: 1, method: 'debug_get_status' });
    assert(viaQuery.status === 200, '查询参数路由返回 200');
    const qBody = JSON.parse(viaQuery.body);
    assert(qBody.result?.echoed === 'debug_get_status', '后端收到并回显 method（查询参数路由）');
    assert(backend.getLastBody()?.method === 'debug_get_status', '后端实际收到转发的方法');

    // 2. X-Instance-Id 头路由
    const viaHeader = await httpPost(broker.port, '/mcp', { jsonrpc: '2.0', id: 2, method: 'debug_list_threads' }, { 'X-Instance-Id': 'inst-a' });
    assert(viaHeader.status === 200, 'X-Instance-Id 头路由返回 200');
    assert(JSON.parse(viaHeader.body).result?.echoed === 'debug_list_threads', '头路由正确转发');

    // 3. 单实例时缺 instanceId 自动路由（兼容静态 MCP 配置的客户端）
    const autoRoute = await httpPost(broker.port, '/mcp', { jsonrpc: '2.0', id: 3, method: 'debug_get_status' });
    assert(autoRoute.status === 200, '单实例时缺 instanceId 自动路由');
    assert(JSON.parse(autoRoute.body).result?.echoed === 'debug_get_status', '自动路由到唯一后端');

    // 4. 多实例时缺 instanceId 必须报错
    await httpPost(broker.port, '/register', { instanceId: 'inst-b', port: backend.port });
    const ambiguous = await httpPost(broker.port, '/mcp', { jsonrpc: '2.0', id: 4, method: 'debug_get_status' });
    assert(ambiguous.status === 400, '多实例时缺 instanceId 返回 400');
    await httpPost(broker.port, '/unregister', { instanceId: 'inst-b' });

    // 5. 不存在的实例
    const notFound = await httpPost(broker.port, '/mcp?instanceId=ghost', { method: 'x' });
    assert(notFound.status === 404, '不存在的实例返回 404');

    // 6. 后端不可达
    const deadPort = await reserveFreePort();
    await httpPost(broker.port, '/register', { instanceId: 'inst-dead', port: deadPort });
    const dead = await httpPost(broker.port, '/mcp?instanceId=inst-dead', { method: 'x' });
    assert(dead.status === 502, '后端不可达返回 502');
    await httpPost(broker.port, '/unregister', { instanceId: 'inst-dead' });

    // 7. 注销后路由
    await httpPost(broker.port, '/unregister', { instanceId: 'inst-a' });
    const afterUnreg = await httpPost(broker.port, '/mcp?instanceId=inst-a', { method: 'x' });
    assert(afterUnreg.status === 404, '注销后路由返回 404');

    await broker.stop();
    await new Promise<void>((resolve) => backend.server.close(() => resolve()));
}

export async function run(): Promise<{ passed: number; failed: number }> {
    console.log('\n--- Broker 注册/心跳/路由测试 ---');

    await testRegistrationValidation();
    await testHeartbeat();
    await testMCPRouting();

    console.log(`  [小结] 本组 ${passed} 通过, ${failed} 失败`);
    return { passed, failed };
}
