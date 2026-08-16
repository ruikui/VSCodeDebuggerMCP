import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { exec, spawn } from 'child_process';
import {
    DebugStatus, DebuggerState,
    BreakpointInfo,
    DapStopEvent, ProcessInfo,
    SourceMapEntry
} from './types';
import { PauseCaptureManager } from './pauseCaptureManager';
import { AdvancedDebugOps } from './advancedDebugOps';
import { FrameOps } from './frameOps';

export class DebuggerService {
    readonly _instanceId: string;
    _currentThreadId: number | null = null;
    _currentFrameId: number | null = null;
    _currentFrameIndex = 0;
    _pauseId: string | null = null;
    _stopReason: string | null = null;
    _lastStopEvent: DapStopEvent | null = null;
    private _pauseWaiters: Array<{ resolve: (e: DapStopEvent) => void; timer: NodeJS.Timeout }> = [];
    private _trackerDisposables: vscode.Disposable[] = [];
    private _breakpointIdMap: Map<string, vscode.Breakpoint> = new Map();
    private _breakpointCounter = 0;
    private _selectedProcessId: number | null = null;
    private _lastLaunchConfig: vscode.DebugConfiguration | null = null;
    private _lastLaunchFolder: vscode.WorkspaceFolder | null = null;
    readonly _sourceMaps: SourceMapEntry[] = [];

    readonly pauseCapture: PauseCaptureManager;
    readonly advanced: AdvancedDebugOps;
    readonly frames: FrameOps;

    constructor() {
        this._instanceId = `vscode-${process.pid}-${Date.now().toString(36)}`;
        this.pauseCapture = new PauseCaptureManager(this);
        this.advanced = new AdvancedDebugOps(this);
        this.frames = new FrameOps(this);
        this.registerDebugAdapterTracker();
    }

    // ── 辅助 ──
    getWorkspacePath(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''; }
    getActiveSession(): vscode.DebugSession | undefined {
        if (this._selectedProcessId !== null) {
            const sessions = (vscode.debug as any).debugSessions as vscode.DebugSession[] | undefined;
            if (sessions) {
                for (const s of sessions) {
                    if ((s.configuration as any)?.processId === this._selectedProcessId) return s;
                }
            }
        }
        return vscode.debug.activeDebugSession ?? undefined;
    }
    getCurrentState(): DebuggerState {
        if (!this.getActiveSession()) return 'stopped';
        return this._lastStopEvent ? 'paused' : 'running';
    }
    generatePauseId(): string { return `vscode-${process.pid}-pause-${Date.now().toString(36)}`; }
    validatePauseIdRequired(expectedPauseId?: string): { valid: boolean; error?: string } {
        if (!expectedPauseId) return { valid: false, error: 'expectedPauseId is required' };
        if (this._pauseId && expectedPauseId !== this._pauseId) return { valid: false, error: 'stalePauseContext' };
        return { valid: true };
    }
    validatePauseIdOptional(expectedPauseId?: string): { valid: boolean; error?: string } {
        if (expectedPauseId && this._pauseId && expectedPauseId !== this._pauseId) return { valid: false, error: 'stalePauseContext' };
        return { valid: true };
    }
    validateWorkspace(expectedSolution: string): { valid: boolean; error?: string } {
        const ws = this.getWorkspacePath();
        if (ws && expectedSolution && ws !== expectedSolution) return { valid: false, error: `Workspace mismatch: expected ${expectedSolution}, got ${ws}` };
        return { valid: true };
    }
    applySourceMap(filePath: string): string {
        let r = filePath;
        for (const m of this._sourceMaps) { if (r.startsWith(m.from)) { r = path.join(m.to, r.slice(m.from.length)); break; } }
        return r;
    }
    async readSourceFile(filePath: string, preferEditorBuffer = true): Promise<string | null> {
        const mapped = this.applySourceMap(filePath);
        if (preferEditorBuffer) {
            const uri = vscode.Uri.file(mapped);
            const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
            if (doc) return doc.getText();
        }
        try { return await fs.promises.readFile(mapped, 'utf-8'); } catch { return null; }
    }

    // ── DAP 事件追踪 ──
    private registerDebugAdapterTracker() {
        const d = vscode.debug.registerDebugAdapterTrackerFactory('*', {
            createDebugAdapterTracker: (_s: vscode.DebugSession) => ({
                onDidSendMessage: (m: any) => {
                    if (m.type === 'event' && m.event === 'stopped') this.handleStopEvent(m.body);
                    if (m.type === 'event' && (m.event === 'terminated' || m.event === 'exited')) this.handleTerminateEvent();
                }
            })
        });
        this._trackerDisposables.push(d);
    }
    handleStopEvent(event: DapStopEvent) {
        this._lastStopEvent = event;
        this._stopReason = event.reason;
        this._currentThreadId = event.threadId ?? this._currentThreadId;
        this._pauseId = this.generatePauseId();
        this._currentFrameId = null;
        this._currentFrameIndex = 0;
        const waiters = this._pauseWaiters.splice(0);
        for (const w of waiters) { clearTimeout(w.timer); try { w.resolve(event); } catch {} }
        if (this.pauseCapture.isActive()) this.pauseCapture.autoCapture().catch(() => {});
    }
    handleTerminateEvent() {
        this._lastStopEvent = null; this._stopReason = null; this._currentThreadId = null;
        this._currentFrameId = null; this._currentFrameIndex = 0; this._pauseId = null;
    }

    // ═══ 1+2. debug_get_status（合并了原 instance_info 和 stop_reason） ═══
    getDebugStatus(expectedPauseId?: string): DebugStatus {
        const s = this.getActiveSession();
        const v = this.validatePauseIdOptional(expectedPauseId);
        const stale = !v.valid;
        return {
            instanceId: this._instanceId, ide: 'Visual Studio Code', version: vscode.version,
            workspace: this.getWorkspacePath(),
            state: this.getCurrentState(), hasActiveSession: !!s,
            sessionName: s?.name ?? null, sessionType: s?.type ?? null,
            processId: (s?.configuration as any)?.processId ?? null,
            threadId: this._currentThreadId, frameId: this._currentFrameId,
            frameIndex: this._currentFrameIndex, pauseId: this._pauseId, stopReason: this._stopReason,
            stale: stale || undefined
        };
    }

    // ═══ 3. debug_list_processes ═══
    async listProcesses(nameFilter?: string, limit = 100): Promise<ProcessInfo[]> {
        const plat = os.platform();
        const cmd = plat === 'win32'
            ? 'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Csv -NoTypeInformation"'
            : 'ps -eo pid,comm,args';
        return new Promise((resolve) => {
            exec(cmd, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout) => {
                if (err) { resolve([]); return; }
                const lines = stdout.split('\n').map(l => l.trim()).filter(l => l);
                const results: ProcessInfo[] = [];
                if (plat === 'win32') {
                    const cols = lines[0].replace(/"/g, '').toLowerCase().split(',');
                    const pi = cols.indexOf('processid'), ni = cols.indexOf('name'), ci = cols.indexOf('commandline'), ei = cols.indexOf('executablepath');
                    for (let i = 1; i < lines.length && results.length < limit; i++) {
                        const p = this.parseCsv(lines[i]);
                        const pid = parseInt(p[pi]?.trim() || '0', 10); if (!pid) continue;
                        const name = p[ni]?.trim() || '', cl = ci >= 0 ? (p[ci]?.trim() || '') : '', exe = ei >= 0 ? (p[ei]?.trim() || '') : '';
                        if (nameFilter) { const f = nameFilter.toLowerCase(); if (!name.toLowerCase().includes(f) && !cl.toLowerCase().includes(f)) continue; }
                        results.push({ pid, name, commandLine: cl, executablePath: exe || null });
                    }
                } else {
                    for (let i = 0; i < lines.length && results.length < limit; i++) {
                        const p = lines[i].trim().split(/\s+/);
                        const pid = parseInt(p[0] || '0', 10); if (!pid) continue;
                        const name = p[1] || '', cl = p.slice(2).join(' ');
                        if (nameFilter) { const f = nameFilter.toLowerCase(); if (!name.toLowerCase().includes(f) && !cl.toLowerCase().includes(f)) continue; }
                        let exe: string | null = name || null;
                        if (plat !== 'darwin') { try { const r = fs.readlinkSync(`/proc/${pid}/exe`); if (r) exe = r; } catch {} }
                        results.push({ pid, name, commandLine: cl, executablePath: exe });
                    }
                }
                resolve(results);
            });
        });
    }
    private parseCsv(line: string): string[] {
        const r: string[] = []; let cur = '', q = false;
        for (const c of line) { if (c === '"') q = !q; else if (c === ',' && !q) { r.push(cur); cur = ''; } else cur += c; }
        r.push(cur); return r;
    }
    private async waitForProcess(pid: number, timeoutMs: number): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const procs = await this.listProcesses(undefined, 500);
            if (procs.some(p => p.pid === pid)) return true;
            await new Promise(r => setTimeout(r, 200));
        }
        return false;
    }
    private async waitForSessionEnd(session: vscode.DebugSession, timeoutMs: number): Promise<void> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (vscode.debug.activeDebugSession !== session) return;
            await new Promise(r => setTimeout(r, 100));
        }
    }
    private parseArgs(str: string): string[] {
        const args: string[] = [];
        const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(str)) !== null) args.push(m[1] ?? m[2] ?? m[3]);
        return args;
    }

    // ═══ 4. debug_verify_target → 已移除（attach_process 已包含验证逻辑） ═══

    // ═══ 5. debug_attach_process ═══
    async attachProcess(opts: { processId?: number; processName?: string; expectedExecutable: string; expectedSolution: string; engine?: string }): Promise<{ attached: boolean; message: string }> {
        const wsCheck = this.validateWorkspace(opts.expectedSolution);
        if (!wsCheck.valid) return { attached: false, message: wsCheck.error! };
        let pid = opts.processId;
        if (!pid && opts.processName) {
            const procs = await this.listProcesses(opts.processName, 10);
            if (procs.length === 0) return { attached: false, message: `No process matching "${opts.processName}"` };
            pid = procs[0].pid;
        }
        if (!pid) return { attached: false, message: 'processId or processName required' };
        const procs = await this.listProcesses(undefined, 500);
        const proc = procs.find(p => p.pid === pid);
        const exe = proc?.executablePath ?? proc?.name ?? '';
        if (exe.toLowerCase() !== opts.expectedExecutable.toLowerCase()) return { attached: false, message: `Executable mismatch: expected ${opts.expectedExecutable}, got ${exe}` };
        const config: vscode.DebugConfiguration = { type: opts.engine ?? 'cppdbg', name: `Attach to PID ${pid}`, request: 'attach', processId: pid } as any;
        const folder = vscode.workspace.workspaceFolders?.[0];
        const ok = await vscode.debug.startDebugging(folder, config);
        return { attached: ok, message: ok ? `Attached to PID ${pid}` : `Failed to attach to PID ${pid}` };
    }

    // ═══ 6. debug_launch_and_attach ═══
    async launchAndAttach(opts: { executable: string; arguments?: string; workingDirectory?: string; expectedSolution: string; engine?: string; timeoutMs?: number }): Promise<{ launched: boolean; attached: boolean; processId: number | null; message: string }> {
        const wsCheck = this.validateWorkspace(opts.expectedSolution);
        if (!wsCheck.valid) return { launched: false, attached: false, processId: null, message: wsCheck.error! };
        if (!fs.existsSync(opts.executable)) return { launched: false, attached: false, processId: null, message: `Executable not found: ${opts.executable}` };
        const workDir = opts.workingDirectory || path.dirname(opts.executable);
        const args = opts.arguments ? this.parseArgs(opts.arguments) : [];
        const child = spawn(opts.executable, args, { cwd: workDir, detached: true, stdio: 'ignore' });
        child.unref();
        const pid = child.pid ?? null;
        if (!pid) return { launched: false, attached: false, processId: null, message: 'Failed to launch' };
        const timeoutMs = opts.timeoutMs ?? 30000;
        const ready = await this.waitForProcess(pid, timeoutMs);
        if (!ready) return { launched: true, attached: false, processId: pid, message: `Launched PID ${pid} but it did not appear within ${timeoutMs}ms` };
        const config: vscode.DebugConfiguration = { type: opts.engine ?? 'cppdbg', name: `Attach to ${path.basename(opts.executable)}`, request: 'attach', processId: pid } as any;
        const folder = vscode.workspace.workspaceFolders?.[0];
        const ok = await vscode.debug.startDebugging(folder, config);
        return { launched: true, attached: ok, processId: pid, message: ok ? `Launched and attached to PID ${pid}` : `Launched PID ${pid} but attach failed` };
    }

    // ═══ 7. debug_detach_process ═══
    async detachProcess(_processId?: number): Promise<{ detached: boolean; message: string }> {
        const s = this.getActiveSession();
        if (!s) return { detached: false, message: 'No active debug session' };
        try { await s.customRequest('disconnect', { restart: false }); return { detached: true, message: 'Detached' }; }
        catch { try { await vscode.debug.stopDebugging(s); return { detached: true, message: 'Stopped' }; } catch (e: any) { return { detached: false, message: `Failed: ${e.message}` }; } }
    }

    // ═══ 8. debug_select_process ═══
    async selectProcess(processId: number): Promise<{ selected: boolean; message: string }> {
        const sessions = (vscode.debug as any).debugSessions as vscode.DebugSession[] | undefined;
        const found = sessions?.find(s => (s.configuration as any)?.processId === processId);
        if (!found) return { selected: false, message: `No debug session for PID ${processId}` };
        this._selectedProcessId = processId;
        return { selected: true, message: `Selected process ${processId}` };
    }

    // ═══ 9. debug_add_breakpoint ═══
    async addBreakpoint(opts: { file: string; line: number; condition?: string }): Promise<{ id: string; verified: boolean; message: string }> {
        if (!opts.file || typeof opts.line !== 'number' || opts.line < 1) return { id: '', verified: false, message: 'file and a line >= 1 are required' };
        const loc = new vscode.Location(vscode.Uri.file(opts.file), new vscode.Range(opts.line - 1, 0, opts.line - 1, 0));
        const bp = new vscode.SourceBreakpoint(loc, true, opts.condition);
        vscode.debug.addBreakpoints([bp]);
        const id = `bp-${++this._breakpointCounter}`;
        this._breakpointIdMap.set(id, bp);
        return { id, verified: true, message: '' };
    }

    // ═══ 10. debug_list_breakpoints ═══
    listBreakpoints(): BreakpointInfo[] {
        const results: BreakpointInfo[] = [];
        for (const bp of vscode.debug.breakpoints) {
            let id = '';
            for (const [k, v] of this._breakpointIdMap) { if (v === bp) { id = k; break; } }
            if (!id) { id = `bp-${++this._breakpointCounter}`; this._breakpointIdMap.set(id, bp); }
            if (bp instanceof vscode.SourceBreakpoint) {
                const logMessage = (bp as any).logMessage ?? null;
                results.push({ id, type: logMessage ? 'log' : 'source', enabled: bp.enabled, file: bp.location.uri.fsPath, line: bp.location.range.start.line + 1, column: bp.location.range.start.character + 1, condition: bp.condition ?? null, hitCondition: bp.hitCondition ?? null, logMessage, verified: true, message: null, tag: null });
            } else if (bp instanceof vscode.FunctionBreakpoint) {
                results.push({ id, type: 'function', enabled: bp.enabled, file: null, line: null, column: null, condition: bp.condition ?? null, hitCondition: bp.hitCondition ?? null, logMessage: null, verified: true, message: null, tag: null });
            }
        }
        return results;
    }

    // ═══ 11. debug_set_breakpoint_enabled ═══
    async setBreakpointEnabled(opts: { file: string; line: number; condition?: string; enabled: boolean }): Promise<{ updated: boolean; message: string }> {
        const target = vscode.debug.breakpoints.find(bp => {
            if (!(bp instanceof vscode.SourceBreakpoint)) return false;
            if (bp.location.uri.fsPath !== opts.file) return false;
            if (bp.location.range.start.line + 1 !== opts.line) return false;
            if (opts.condition && bp.condition !== opts.condition) return false;
            return true;
        });
        if (!target) return { updated: false, message: `Breakpoint at ${opts.file}:${opts.line} not found` };
        vscode.debug.removeBreakpoints([target]);
        const nb = this.recreateBp(target, opts.enabled);
        if (nb) {
            vscode.debug.addBreakpoints([nb]);
            for (const [k, v] of this._breakpointIdMap) { if (v === target) { this._breakpointIdMap.set(k, nb); break; } }
        }
        return { updated: true, message: `Breakpoint at ${opts.file}:${opts.line} ${opts.enabled ? 'enabled' : 'disabled'}` };
    }

    // ═══ 12. debug_remove_breakpoint ═══
    async removeBreakpoint(opts: { file: string; line: number; condition?: string }): Promise<{ removed: boolean; message: string }> {
        const target = vscode.debug.breakpoints.find(bp => {
            if (!(bp instanceof vscode.SourceBreakpoint)) return false;
            if (bp.location.uri.fsPath !== opts.file) return false;
            if (bp.location.range.start.line + 1 !== opts.line) return false;
            if (opts.condition && bp.condition !== opts.condition) return false;
            return true;
        });
        if (!target) return { removed: false, message: `Breakpoint at ${opts.file}:${opts.line} not found` };
        vscode.debug.removeBreakpoints([target]);
        for (const [k, v] of this._breakpointIdMap) { if (v === target) { this._breakpointIdMap.delete(k); break; } }
        return { removed: true, message: `Breakpoint at ${opts.file}:${opts.line} removed` };
    }
    private recreateBp(bp: vscode.Breakpoint, enabled: boolean): vscode.Breakpoint | null {
        if (bp instanceof vscode.SourceBreakpoint) return new vscode.SourceBreakpoint(bp.location, enabled, bp.condition, bp.hitCondition, (bp as any).logMessage);
        if (bp instanceof vscode.FunctionBreakpoint) return new vscode.FunctionBreakpoint((bp as any).functionName, enabled, bp.condition, bp.hitCondition);
        return null;
    }

    // ═══ 12a. debug_add_logpoint ═══
    async addLogpoint(opts: { file: string; line: number; logMessage: string }): Promise<{ id: string; verified: boolean; message: string }> {
        if (!opts.file || typeof opts.line !== 'number' || opts.line < 1) return { id: '', verified: false, message: 'file and a line >= 1 are required' };
        if (!opts.logMessage) return { id: '', verified: false, message: 'logMessage is required' };
        const loc = new vscode.Location(vscode.Uri.file(opts.file), new vscode.Range(opts.line - 1, 0, opts.line - 1, 0));
        const bp = new vscode.SourceBreakpoint(loc, true, undefined, undefined, opts.logMessage);
        vscode.debug.addBreakpoints([bp]);
        const id = `bp-${++this._breakpointCounter}`;
        this._breakpointIdMap.set(id, bp);
        return { id, verified: true, message: '' };
    }

    // ═══ 12b. debug_clear_all_breakpoints ═══
    async clearAllBreakpoints(): Promise<{ removed: number; message: string }> {
        const all = vscode.debug.breakpoints.slice();
        if (all.length === 0) return { removed: 0, message: 'No breakpoints to clear' };
        vscode.debug.removeBreakpoints(all);
        this._breakpointIdMap.clear();
        return { removed: all.length, message: `Cleared ${all.length} breakpoint(s)` };
    }

    // ═══ 13. debug_start ═══
    async startDebugging(opts: { expectedSolution: string }): Promise<{ started: boolean; message: string }> {
        const wsCheck = this.validateWorkspace(opts.expectedSolution);
        if (!wsCheck.valid) return { started: false, message: wsCheck.error! };
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) return { started: false, message: 'No workspace folder' };
        const configs = vscode.workspace.getConfiguration('launch', folder).get<any[]>('configurations', []);
        if (configs.length === 0) return { started: false, message: 'No launch configurations' };
        const config = configs[0];
        this._lastLaunchConfig = config; this._lastLaunchFolder = folder;
        const ok = await vscode.debug.startDebugging(folder, config);
        return { started: ok, message: ok ? `Started "${config.name}"` : 'Failed to start' };
    }

    // ═══ 14. debug_restart ═══
    async restartSession(opts: { processId: number; expectedExecutable: string; expectedSolution: string }): Promise<{ restarted: boolean; message: string }> {
        const wsCheck = this.validateWorkspace(opts.expectedSolution);
        if (!wsCheck.valid) return { restarted: false, message: wsCheck.error! };
        const s = this.getActiveSession();
        if (s) { await vscode.debug.stopDebugging(s); await this.waitForSessionEnd(s, 5000); }
        this.handleTerminateEvent();
        if (this._lastLaunchConfig && this._lastLaunchFolder) {
            const ok = await vscode.debug.startDebugging(this._lastLaunchFolder, this._lastLaunchConfig);
            return { restarted: ok, message: ok ? 'Restarted' : 'Failed to restart' };
        }
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (folder) {
            const configs = vscode.workspace.getConfiguration('launch', folder).get<any[]>('configurations', []);
            if (configs.length > 0) { const ok = await vscode.debug.startDebugging(folder, configs[0]); return { restarted: ok, message: ok ? 'Restarted' : 'Failed' }; }
        }
        return { restarted: false, message: 'No launch configuration to restart' };
    }

    // ═══ 15-20. 执行控制 ═══
    async continueExecution(expectedPauseId: string): Promise<{ continued: boolean; message: string; stale?: boolean }> {
        const v = this.validatePauseIdRequired(expectedPauseId);
        if (!v.valid) return { continued: false, message: v.error!, stale: v.error === 'stalePauseContext' };
        const s = this.getActiveSession(); if (!s) return { continued: false, message: 'No active session' };
        try { await s.customRequest('continue', { threadId: this._currentThreadId ?? 1 }); this._lastStopEvent = null; this._pauseId = null; this._stopReason = null; return { continued: true, message: 'Continued' }; }
        catch (e: any) { return { continued: false, message: `Failed: ${e.message}` }; }
    }
    async pauseExecution(_processId?: number): Promise<{ paused: boolean; message: string }> {
        const s = this.getActiveSession(); if (!s) return { paused: false, message: 'No active session' };
        try { await s.customRequest('pause', { threadId: this._currentThreadId ?? 1 }); return { paused: true, message: 'Pause requested' }; }
        catch (e: any) { return { paused: false, message: `Failed: ${e.message}` }; }
    }
    // ═══ 17. debug_step（合并了原 step_into/step_over/step_out） ═══
    async step(stepAction: 'into' | 'over' | 'out', expectedPauseId: string): Promise<{ stepped: boolean; message: string; stale?: boolean }> {
        const v = this.validatePauseIdRequired(expectedPauseId);
        if (!v.valid) return { stepped: false, message: v.error!, stale: v.error === 'stalePauseContext' };
        const s = this.getActiveSession(); if (!s) return { stepped: false, message: 'No active session' };
        const dapReq = stepAction === 'into' ? 'stepIn' : stepAction === 'out' ? 'stepOut' : 'next';
        const label = stepAction === 'into' ? 'Step into' : stepAction === 'out' ? 'Step out' : 'Step over';
        try { await s.customRequest(dapReq, { threadId: this._currentThreadId ?? 1 }); this._lastStopEvent = null; this._pauseId = null; this._stopReason = null; return { stepped: true, message: label }; }
        catch (e: any) { return { stepped: false, message: `Failed: ${e.message}` }; }
    }
    async stopDebugging(_processId?: number): Promise<{ stopped: boolean; message: string }> {
        const s = this.getActiveSession(); if (!s) return { stopped: false, message: 'No active session' };
        try { await vscode.debug.stopDebugging(s); this.handleTerminateEvent(); return { stopped: true, message: 'Stopped' }; }
        catch (e: any) { return { stopped: false, message: `Failed: ${e.message}` }; }
    }

    // ═══ 21. debug_wait_for_pause ═══
    async waitForPause(timeoutMs = 30000): Promise<DebugStatus> {
        if (this._lastStopEvent) return this.getDebugStatus();
        if (!this.getActiveSession()) return this.getDebugStatus();
        return new Promise<DebugStatus>((resolve) => {
            const timer = setTimeout(() => { const i = this._pauseWaiters.indexOf(w); if (i >= 0) this._pauseWaiters.splice(i, 1); resolve(this.getDebugStatus()); }, timeoutMs);
            const w = { resolve: () => resolve(this.getDebugStatus()), timer };
            this._pauseWaiters.push(w);
        });
    }

    // ═══ 22. debug_get_stop_reason → 已合并到 debug_get_status ═══

    dispose() {
        for (const d of this._trackerDisposables) { try { d.dispose(); } catch {} }
        this._trackerDisposables = [];
        this._pauseWaiters = [];
    }
}
