import * as vscode from 'vscode';
import { DebuggerService } from './debuggerService';
import { McpServer } from './mcpServer';

let debuggerService: DebuggerService | undefined;
let mcpServer: McpServer | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

export async function activate(context: vscode.ExtensionContext) {
    debuggerService = new DebuggerService();
    const config = vscode.workspace.getConfiguration('vscodeDebuggerMcp');
    const port = config.get<number>('port', 37643);
    const autoStart = config.get<boolean>('autoStart', true);

    mcpServer = new McpServer(debuggerService, port);

    // 状态栏
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
    statusBarItem.command = 'vscodeDebuggerMcp.showStatus';
    statusBarItem.text = '$(debug) VSCodeDebugMCP: Off';
    statusBarItem.tooltip = 'VSCode Debugger MCP';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 命令
    context.subscriptions.push(
        vscode.commands.registerCommand('vscodeDebuggerMcp.showStatus', showStatus),
        vscode.commands.registerCommand('vscodeDebuggerMcp.restart', restartServer),
        vscode.commands.registerCommand('vscodeDebuggerMcp.start', startServer),
        vscode.commands.registerCommand('vscodeDebuggerMcp.stop', stopServer)
    );

    // 配置变更监听
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscodeDebuggerMcp.port')) {
                const newPort = vscode.workspace.getConfiguration('vscodeDebuggerMcp').get<number>('port', 37643);
                if (mcpServer && mcpServer.isRunning && newPort !== mcpServer.port) {
                    restartServer(newPort);
                }
            }
        })
    );

    // 调试会话生命周期
    context.subscriptions.push(
        vscode.debug.onDidStartDebugSession(() => {
            updateStatusBar();
        }),
        vscode.debug.onDidTerminateDebugSession(() => {
            updateStatusBar();
        })
    );

    // 自动启动
    if (autoStart) {
        await startServer();
    }

    // 定时刷新状态栏
    const interval = setInterval(updateStatusBar, 2000);
    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export async function deactivate() {
    if (mcpServer) {
        await mcpServer.stop();
    }
    if (debuggerService) {
        debuggerService.dispose();
    }
}

async function startServer(): Promise<void> {
    if (!mcpServer) return;
    const ok = await mcpServer.start();
    if (ok) {
        vscode.window.showInformationMessage(`VSCode Debugger MCP started on port ${mcpServer.port}`);
    } else {
        vscode.window.showErrorMessage(`VSCode Debugger MCP failed to start on port ${mcpServer.port}`);
    }
    updateStatusBar();
}

async function restartServer(newPort?: number): Promise<void> {
    if (!mcpServer) return;
    const ok = await mcpServer.restart(newPort);
    if (ok) {
        vscode.window.showInformationMessage(`VSCode Debugger MCP restarted on port ${mcpServer.port}`);
    } else {
        vscode.window.showErrorMessage(`VSCode Debugger MCP failed to restart on port ${mcpServer.port}`);
    }
    updateStatusBar();
}

function updateStatusBar(): void {
    if (!statusBarItem || !mcpServer || !debuggerService) return;
    const running = mcpServer.isRunning;
    const status = debuggerService.getCurrentState();
    const session = vscode.debug.activeDebugSession;

    if (!running) {
        statusBarItem.text = '$(debug) VSCodeDebugMCP: Off';
        statusBarItem.tooltip = 'VSCode Debugger MCP (stopped)';
    } else if (session) {
        const icon = status === 'paused' ? '$(debug-pause)' : '$(debug-start)';
        statusBarItem.text = `${icon} VSCodeDebugMCP:${mcpServer.port} ${status}`;
        statusBarItem.tooltip = `VSCode Debugger MCP\nPort: ${mcpServer.port}\nSession: ${session.name}\nState: ${status}`;
    } else {
        statusBarItem.text = `$(debug) VSCodeDebugMCP:${mcpServer.port}`;
        statusBarItem.tooltip = `VSCode Debugger MCP\nPort: ${mcpServer.port}\nNo active debug session`;
    }
}

async function showStatus(): Promise<void> {
    if (!mcpServer || !debuggerService) return;

    const running = mcpServer.isRunning;
    const port = mcpServer.port;

    const items: Array<vscode.QuickPickItem & { action?: string }> = [
        { label: running ? '$(debug-start) 重启 MCP 服务' : '$(debug-start) 开始 MCP 服务', action: running ? 'restart' : 'start' },
        { label: '$(debug-stop) 停止 MCP 服务', action: 'stop', description: running ? undefined : '(未运行)' },
        { label: `$(gear) 修改端口 (当前: ${port})`, action: 'changePort' },
        { label: '$(terminal) 查看详细状态', action: 'details' },
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `VSCodeDebugMCP — ${running ? `运行中 :${port}` : '已停止'}`,
    });

    if (!picked || !picked.action) return;

    switch (picked.action) {
        case 'start':
            await startServer();
            break;
        case 'restart':
            await restartServer();
            break;
        case 'stop':
            await stopServer();
            break;
        case 'changePort':
            await changePort();
            break;
        case 'details':
            await showDetails();
            break;
    }
}

async function stopServer(): Promise<void> {
    if (!mcpServer) return;
    await mcpServer.stop();
    vscode.window.showInformationMessage(`VSCode Debugger MCP stopped`);
    updateStatusBar();
}

async function changePort(): Promise<void> {
    if (!mcpServer) return;
    const input = await vscode.window.showInputBox({
        prompt: '输入新的端口号 (1024–65535)',
        value: String(mcpServer.port),
        validateInput: (v) => {
            const n = parseInt(v, 10);
            if (isNaN(n) || n < 1024 || n > 65535) return '请输入 1024–65535 之间的数字';
            return undefined;
        },
    });
    if (!input) return;
    const newPort = parseInt(input, 10);
    if (newPort === mcpServer.port) return;
    await vscode.workspace.getConfiguration('vscodeDebuggerMcp').update('port', newPort, vscode.ConfigurationTarget.Global);
    const ok = await mcpServer.restart(newPort);
    if (ok) {
        vscode.window.showInformationMessage(`VSCode Debugger MCP restarted on port ${newPort}`);
    } else {
        vscode.window.showErrorMessage(`VSCode Debugger MCP failed to restart on port ${newPort}`);
    }
    updateStatusBar();
}

async function showDetails(): Promise<void> {
    if (!mcpServer || !debuggerService) return;
    const status = debuggerService.getDebugStatus();
    const log = mcpServer.getLog().slice(-10).join('\n');

    const panel = vscode.window.createOutputChannel('VSCode Debugger MCP');
    panel.clear();
    panel.appendLine('═══════════════════════════════════════');
    panel.appendLine('  VSCode Debugger MCP - Status');
    panel.appendLine('═══════════════════════════════════════');
    panel.appendLine('');
    panel.appendLine(`Server:        ${mcpServer.isRunning ? 'Running' : 'Stopped'}`);
    panel.appendLine(`Endpoint:      ${mcpServer.endpoint}`);
    panel.appendLine(`Instance ID:   ${status.instanceId}`);
    panel.appendLine(`IDE:           ${status.ide} ${status.version}`);
    panel.appendLine(`Workspace:     ${status.workspace || '(none)'}`);
    panel.appendLine(`Debug Session: ${status.sessionName ?? '(none)'}`);
    panel.appendLine(`Session Type:  ${status.sessionType ?? '(none)'}`);
    panel.appendLine(`State:         ${status.state}`);
    panel.appendLine(`Thread ID:     ${status.threadId ?? '(none)'}`);
    panel.appendLine(`Frame ID:      ${status.frameId ?? '(none)'}`);
    panel.appendLine(`Pause ID:      ${status.pauseId ?? '(none)'}`);
    panel.appendLine(`Stop Reason:   ${status.stopReason ?? '(none)'}`);
    panel.appendLine('');
    panel.appendLine('── Recent Log ──');
    panel.appendLine(log || '(no log entries)');
    panel.show();
}
