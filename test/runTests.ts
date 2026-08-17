/**
 * 测试入口：运行所有自动化测试。
 * 用法：npm test
 */
import * as http from 'http';
import { Broker } from '../src/broker';
import { run as runSecretRedaction } from './secretRedaction.test';
import { run as runToolDefinitions } from './toolDefinitions.test';
import { run as runBrokerRoute } from './brokerRoute.test';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) { console.log(`  [PASS] ${label}`); passed++; }
    else { console.error(`  [FAIL] ${label}`); failed++; }
}

/** HTTP GET 请求辅助 */
function httpGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
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

/** HTTP POST 请求辅助 */
function httpPost(port: number, path: string, body: object): Promise<{ status: number; body: string }> {
    return new Promise((resolve) => {
        const data = JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

async function testBrokerStart(): Promise<void> {
    console.log('\n--- Broker 启动测试 ---');
    const broker = new Broker(0);
    const ok = await broker.start();
    assert(ok, 'Broker 在随机端口启动');
    assert(broker.isRunning, 'Broker isRunning 为 true');
    assert(broker.port > 0, `Broker 分配了实际端口 ${broker.port}`);
    await broker.stop();
}

async function testHealthCheck(): Promise<void> {
    console.log('\n--- 健康检查测试 ---');
    const broker = new Broker(0);
    await broker.start();
    const res = await httpGet(broker.port, '/health', { host: '127.0.0.1' });
    assert(res.status === 200, 'GET /health 返回 200');
    const body = JSON.parse(res.body);
    assert(body.broker === true, '响应包含 broker: true');
    assert(body.instances === 0, '初始实例数为 0');
    await broker.stop();
}

async function testHostValidation(): Promise<void> {
    console.log('\n--- Host 头校验测试（防 DNS-rebinding） ---');
    const broker = new Broker(0);
    await broker.start();

    const okHost = await httpGet(broker.port, '/health', { host: '127.0.0.1' });
    assert(okHost.status === 200, 'Host: 127.0.0.1 被接受');

    const okLocalhost = await httpGet(broker.port, '/health', { host: 'localhost' });
    assert(okLocalhost.status === 200, 'Host: localhost 被接受');

    const badHost = await httpGet(broker.port, '/health', { host: 'evil.com' });
    assert(badHost.status === 403, 'Host: evil.com 被拒绝（DNS-rebinding 防护）');

    await broker.stop();
}

async function testInstanceRegistration(): Promise<void> {
    console.log('\n--- 实例注册与路由测试 ---');
    const broker = new Broker(0);
    await broker.start();

    const reg = await httpPost(broker.port, '/register', { instanceId: 'test-instance-1', port: 9999 });
    assert(reg.status === 200, '注册实例返回 200');
    assert(broker.instanceCount === 1, '实例数为 1');

    const list = await httpGet(broker.port, '/instances', { host: '127.0.0.1' });
    const listBody = JSON.parse(list.body);
    assert(listBody.instances.length === 1, '列出 1 个实例');
    assert(listBody.instances[0].instanceId === 'test-instance-1', 'instanceId 匹配');

    const unreg = await httpPost(broker.port, '/unregister', { instanceId: 'test-instance-1' });
    assert(unreg.status === 200, '注销实例返回 200');
    assert(broker.instanceCount === 0, '注销后实例数为 0');

    await broker.stop();
}

async function testOriginValidation(): Promise<void> {
    console.log('\n--- Origin 头校验测试 ---');
    const broker = new Broker(0);
    await broker.start();

    // 无 Origin 头（非浏览器请求）应放行
    const noOrigin = await httpGet(broker.port, '/health', { host: '127.0.0.1' });
    assert(noOrigin.status === 200, '无 Origin 头放行');

    // 本地回环 Origin 应放行
    const okOrigin = await httpGet(broker.port, '/health', { host: '127.0.0.1', origin: 'http://127.0.0.1:8080' });
    assert(okOrigin.status === 200, 'Origin: http://127.0.0.1:8080 放行');

    // 跨域 Origin 应拒绝
    const badOrigin = await httpGet(broker.port, '/health', { host: '127.0.0.1', origin: 'http://evil.com' });
    assert(badOrigin.status === 403, 'Origin: http://evil.com 被拒绝');

    await broker.stop();
}

async function main(): Promise<void> {
    console.log('=== VSCodeDebuggerMCP 自动化测试 ===');

    await testBrokerStart();
    await testHealthCheck();
    await testHostValidation();
    await testInstanceRegistration();
    await testOriginValidation();

    // 新增测试组（各自返回独立的通过/失败计数）
    const sr = await runSecretRedaction();
    const td = await runToolDefinitions();
    const br = await runBrokerRoute();
    passed += sr.passed + td.passed + br.passed;
    failed += sr.failed + td.failed + br.failed;

    console.log(`\n=== 结果: ${passed} 通过, ${failed} 失败 ===`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
