import * as vscode from 'vscode';
import { DebuggerService } from './debuggerService';
import { StackFrame, Variable, Thread, PauseContext } from './types';

/**
 * 栈帧/线程/变量/源码/捕获操作（工具 23-32）。
 */
export class FrameOps {
    constructor(private readonly svc: DebuggerService) {}

    private get session(): vscode.DebugSession | undefined { return this.svc.getActiveSession(); }

    // ═══ 23. debug_list_threads ═══
    async listThreads(limit = 100, expectedPauseId?: string): Promise<Thread[]> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return [];
        const s = this.session; if (!s) return [];
        try { const r = await s.customRequest('threads'); return ((r as any).threads ?? []).slice(0, limit); }
        catch { return []; }
    }

    // ═══ 24. debug_select_thread ═══
    async selectThread(threadId: number, expectedPauseId: string): Promise<{ selected: boolean; message: string; stale?: boolean }> {
        const v = this.svc.validatePauseIdRequired(expectedPauseId);
        if (!v.valid) return { selected: false, message: v.error!, stale: v.error === 'stalePauseContext' };
        this.svc._currentThreadId = threadId;
        this.svc._currentFrameId = null;
        this.svc._currentFrameIndex = 0;
        return { selected: true, message: `Thread ${threadId} selected` };
    }

    // ═══ 25. debug_select_frame ═══
    async selectFrame(frameIndex: number, expectedPauseId: string): Promise<{ selected: boolean; message: string; stale?: boolean }> {
        const v = this.svc.validatePauseIdRequired(expectedPauseId);
        if (!v.valid) return { selected: false, message: v.error!, stale: v.error === 'stalePauseContext' };
        const frame = await this.getFrameByIndex(frameIndex);
        if (!frame) return { selected: false, message: `Frame ${frameIndex} not found` };
        this.svc._currentFrameId = frame.id;
        this.svc._currentFrameIndex = frameIndex;
        return { selected: true, message: `Frame ${frameIndex} (${frame.name}) selected` };
    }

    // ═══ 26. debug_get_frame_locals ═══
    async getFrameLocals(frameIndex: number, maxDepth = 1, maxItems = 100, expectedPauseId?: string): Promise<{ arguments: Variable[]; locals: Variable[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { arguments: [], locals: [], stale: true };
        const s = this.session; if (!s) return { arguments: [], locals: [] };
        const frame = await this.getFrameByIndex(frameIndex);
        if (!frame) return { arguments: [], locals: [] };
        return this.getScopesAndVariables(s, frame.id, maxDepth, maxItems);
    }

    // ═══ 27. debug_get_current_frame ═══
    async getCurrentFrame(expectedPauseId?: string): Promise<{ frame: StackFrame | null; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { frame: null, stale: true };
        const stack = await this.getCallStackInternal(this.svc._currentFrameIndex, 1);
        return { frame: stack.length > 0 ? stack[0] : null };
    }

    // ═══ 28. debug_get_call_stack ═══
    async getCallStack(limit = 50, expectedPauseId?: string): Promise<StackFrame[]> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return [];
        return this.getCallStackInternal(0, limit);
    }

    // ═══ 29. debug_get_source_context ═══
    async getSourceContext(opts: { frameIndex?: number; linesBefore?: number; linesAfter?: number; preferEditorBuffer?: boolean; expectedPauseId?: string }): Promise<{ file: string; startLine: number; endLine: number; lines: string[] } | null> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return null;
        const idx = opts.frameIndex ?? this.svc._currentFrameIndex;
        const frame = await this.getFrameByIndex(idx);
        if (!frame?.source?.path) return null;
        return this.readSourceContext(frame.source.path, frame.line, opts.linesBefore ?? 30, opts.linesAfter ?? 30, opts.preferEditorBuffer ?? true);
    }

    // ═══ 30. debug_capture_pause_context ═══
    async capturePauseContext(opts: { stackLimit?: number; linesBefore?: number; linesAfter?: number; maxDepth?: number; maxItems?: number; preferEditorBuffer?: boolean; expectedPauseId?: string }): Promise<PauseContext> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        const stale = !v.valid;
        const s = this.session;
        const threads = s ? await this.listThreads(100) : [];
        const callStack = stale ? [] : await this.getCallStackInternal(0, opts.stackLimit ?? 20);
        const frame = callStack.length > 0 ? callStack[0] : null;
        let sourceContext: PauseContext['sourceContext'] = null;
        if (frame?.source?.path) {
            sourceContext = await this.readSourceContext(frame.source.path, frame.line, opts.linesBefore ?? 30, opts.linesAfter ?? 30, opts.preferEditorBuffer ?? true);
        }
        let locals: Variable[] = [];
        let args: Variable[] = [];
        if (s && frame && !stale) {
            const r = await this.getScopesAndVariables(s, frame.id, opts.maxDepth ?? 1, opts.maxItems ?? 100);
            locals = r.locals; args = r.arguments;
        }
        const bps = this.svc.listBreakpoints().filter(bp => bp.verified && bp.enabled);
        return {
            pauseId: this.svc._pauseId ?? '', reason: this.svc._stopReason ?? 'unknown',
            threadId: this.svc._currentThreadId ?? 0, frame, callStack, sourceContext,
            locals, arguments: args, threads, matchingBreakpoints: bps
        };
    }

    // ═══ 31. debug_get_locals ═══
    async getLocals(maxDepth = 1, maxItems = 100, expectedPauseId?: string): Promise<{ arguments: Variable[]; locals: Variable[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { arguments: [], locals: [], stale: true };
        const s = this.session; if (!s) return { arguments: [], locals: [] };
        if (this.svc._currentFrameId === null) {
            const frame = await this.getFrameByIndex(this.svc._currentFrameIndex);
            if (frame) this.svc._currentFrameId = frame.id;
        }
        if (this.svc._currentFrameId === null) return { arguments: [], locals: [] };
        return this.getScopesAndVariables(s, this.svc._currentFrameId, maxDepth, maxItems);
    }

    // ═══ 32. debug_evaluate ═══
    async evaluate(opts: { expression: string; timeoutMs?: number; maxDepth?: number; maxItems?: number; expectedPauseId?: string }): Promise<{ result: string; type: string | null; children: Variable[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { result: '', type: null, children: [], stale: true };
        const s = this.session; if (!s) return { result: '', type: null, children: [] };
        if (this.svc._currentFrameId === null) {
            const frame = await this.getFrameByIndex(this.svc._currentFrameIndex);
            if (frame) this.svc._currentFrameId = frame.id;
        }
        try {
            const r = await this.withTimeout(Promise.resolve(s.customRequest('evaluate', { expression: opts.expression, frameId: this.svc._currentFrameId, context: 'watch' })), opts.timeoutMs ?? 3000);
            const body = r as any;
            const children: Variable[] = [];
            if (body.variablesReference > 0 && (opts.maxDepth ?? 0) > 0) {
                await this.collectVariables(s, body.variablesReference, children, opts.maxDepth ?? 0, 0, opts.maxItems ?? 50, new Set());
            }
            return { result: body.result ?? '', type: body.type ?? null, children };
        } catch (e: any) {
            return { result: `Error: ${e.message}`, type: null, children: [] };
        }
    }

    // ── 内部辅助 ──
    async getFrameByIndex(frameIndex: number): Promise<StackFrame | null> {
        const stack = await this.getCallStackInternal(frameIndex, 1);
        return stack.length > 0 ? stack[0] : null;
    }
    private async getCallStackInternal(startFrame: number, limit: number): Promise<StackFrame[]> {
        const s = this.session; if (!s) return [];
        const tid = this.svc._currentThreadId ?? 1;
        try {
            const r = await s.customRequest('stackTrace', { threadId: tid, startFrame, maxFrames: limit });
            return (r as any).stackFrames ?? [];
        } catch { return []; }
    }
    private async getScopesAndVariables(session: vscode.DebugSession, frameId: number, maxDepth: number, maxItems: number): Promise<{ arguments: Variable[]; locals: Variable[] }> {
        try {
            const sr = await session.customRequest('scopes', { frameId });
            const scopes = (sr as any).scopes ?? [];
            const arguments_: Variable[] = [];
            const locals: Variable[] = [];
            for (const scope of scopes) {
                const target = scope.name.toLowerCase().includes('arg') ? arguments_ : locals;
                await this.collectVariables(session, scope.variablesReference, target, maxDepth, 0, maxItems, new Set());
            }
            return { arguments: arguments_, locals };
        } catch { return { arguments: [], locals: [] }; }
    }
    async collectVariables(session: vscode.DebugSession, variablesReference: number, collected: Variable[], maxDepth: number, currentDepth: number, maxItems: number, visited: Set<number>): Promise<void> {
        if (currentDepth > maxDepth || collected.length >= maxItems || variablesReference === 0) return;
        if (visited.has(variablesReference)) return;
        visited.add(variablesReference);
        try {
            const r = await session.customRequest('variables', { variablesReference });
            const vars = (r as any).variables ?? [];
            for (const v of vars) {
                if (collected.length >= maxItems) break;
                collected.push(v);
                if (v.variablesReference > 0 && currentDepth < maxDepth) {
                    await this.collectVariables(session, v.variablesReference, collected, maxDepth, currentDepth + 1, maxItems, visited);
                }
            }
        } catch {}
    }
    private async readSourceContext(filePath: string, line: number, before: number, after: number, preferEditorBuffer: boolean): Promise<{ file: string; startLine: number; endLine: number; lines: string[] } | null> {
        const content = await this.svc.readSourceFile(filePath, preferEditorBuffer);
        if (!content) return null;
        const allLines = content.split(/\r?\n/);
        const startLine = Math.max(0, line - before - 1);
        const endLine = Math.min(allLines.length, line + after);
        const lines = allLines.slice(startLine, endLine);
        return { file: filePath, startLine: startLine + 1, endLine, lines };
    }
    private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
        return Promise.race([
            promise,
            new Promise<T>((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
        ]);
    }
}
