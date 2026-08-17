import * as vscode from 'vscode';
import { DebuggerService } from './debuggerService';
import { StackFrame, Variable, Thread, PauseContext } from './types';
import { redactVariables, redactExpressionResult, REDACTION_NOTICE } from './secretRedaction';

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

    // ═══ 26+31. debug_get_frame_locals（合并了原 debug_get_locals，frameIndex 可选，省略时用当前帧） ═══
    async getFrameLocals(frameIndex?: number, maxDepth = 1, maxItems = 100, expectedPauseId?: string, names?: string[]): Promise<{ arguments: Variable[]; locals: Variable[]; stale?: boolean; redacted?: boolean; redactionNotice?: string | null }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { arguments: [], locals: [], stale: true };
        const s = this.session; if (!s) return { arguments: [], locals: [] };
        let frameId: number | null = null;
        if (frameIndex !== undefined) {
            const frame = await this.getFrameByIndex(frameIndex);
            if (!frame) return { arguments: [], locals: [] };
            frameId = frame.id;
        } else {
            if (this.svc._currentFrameId === null) {
                const frame = await this.getFrameByIndex(this.svc._currentFrameIndex);
                if (frame) this.svc._currentFrameId = frame.id;
            }
            frameId = this.svc._currentFrameId;
        }
        if (frameId === null) return { arguments: [], locals: [] };
        const r = await this.getScopesAndVariables(s, frameId, maxDepth, maxItems);
        let args = r.arguments, locals = r.locals;
        let anyRed = false;
        if (names && names.length > 0) {
            const nameSet = new Set(names);
            args = args.filter(vr => nameSet.has(vr.name) || (vr.evaluateName && nameSet.has(vr.evaluateName)));
            locals = locals.filter(vr => nameSet.has(vr.name) || (vr.evaluateName && nameSet.has(vr.evaluateName)));
        }
        const ar = redactVariables(args); const lr = redactVariables(locals);
        anyRed = ar.redacted || lr.redacted;
        return { arguments: ar.variables, locals: lr.variables, redacted: anyRed, redactionNotice: anyRed ? REDACTION_NOTICE : null };
    }

    // ═══ 27+28. debug_get_call_stack（合并了原 debug_get_current_frame，返回 frames + currentFrame） ═══
    async getCallStack(limit = 50, expectedPauseId?: string): Promise<{ frames: StackFrame[]; currentFrame: StackFrame | null; currentFrameIndex: number | null; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { frames: [], currentFrame: null, currentFrameIndex: this.svc._currentFrameIndex, stale: true };
        const frames = await this.getCallStackInternal(0, limit);
        const idx = this.svc._currentFrameIndex;
        let currentFrame: StackFrame | null = null;
        if (idx >= 0 && idx < frames.length) {
            currentFrame = frames[idx];
        } else if (idx >= 0) {
            const single = await this.getCallStackInternal(idx, 1);
            currentFrame = single.length > 0 ? single[0] : null;
        }
        return { frames, currentFrame, currentFrameIndex: idx };
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
    async capturePauseContext(opts: { stackLimit?: number; linesBefore?: number; linesAfter?: number; maxDepth?: number; maxItems?: number; preferEditorBuffer?: boolean; expectedPauseId?: string }): Promise<PauseContext & { stale?: boolean; redacted?: boolean; redactionNotice?: string | null }> {
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
        let anyRed = false;
        if (s && frame && !stale) {
            const r = await this.getScopesAndVariables(s, frame.id, opts.maxDepth ?? 1, opts.maxItems ?? 100);
            const ar = redactVariables(r.arguments); const lr = redactVariables(r.locals);
            args = ar.variables; locals = lr.variables;
            anyRed = ar.redacted || lr.redacted;
        }
        const bps = this.svc.listBreakpoints().filter(bp => bp.verified && bp.enabled);
        return {
            pauseId: this.svc._pauseId ?? '', reason: this.svc._stopReason ?? 'unknown',
            threadId: this.svc._currentThreadId ?? 0, frame, callStack, sourceContext,
            locals, arguments: args, threads, matchingBreakpoints: bps,
            redacted: anyRed, redactionNotice: anyRed ? REDACTION_NOTICE : null,
            stale: stale || undefined
        };
    }

    // ═══ 31. debug_get_locals → 已合并到 debug_get_frame_locals ═══

    // ═══ 31a. debug_list_variable_names ═══
    async listVariableNames(frameIndex: number, expectedPauseId?: string): Promise<{ variables: { name: string; type: string | null; evaluateName: string | null }[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(expectedPauseId);
        if (!v.valid) return { variables: [], stale: true };
        const s = this.session; if (!s) return { variables: [] };
        const frame = await this.getFrameByIndex(frameIndex);
        if (!frame) return { variables: [] };
        const r = await this.getScopesAndVariables(s, frame.id, 0, 500);
        const all = [...r.arguments, ...r.locals];
        return {
            variables: all.map(v => ({
                name: v.name,
                type: v.type ?? null,
                evaluateName: v.evaluateName ?? null
            }))
        };
    }

    // ═══ 31b. debug_get_variables_by_name（最小权限读取，复用 getFrameLocals 的 names 过滤） ═══
    async getVariablesByName(frameIndex: number | undefined, names: string[], maxDepth = 1, expectedPauseId?: string): Promise<{ variables: Variable[]; stale?: boolean; redacted?: boolean; redactionNotice?: string | null }> {
        // 复用 getFrameLocals 的 names 过滤逻辑（保留脱敏和 pauseId 防护）
        const result = await this.getFrameLocals(frameIndex, maxDepth, 100, expectedPauseId, names);
        return {
            variables: result.locals,
            stale: result.stale,
            redacted: result.redacted,
            redactionNotice: result.redactionNotice
        };
    }

    // ═══ 32. debug_evaluate ═══
    async evaluate(opts: { expression: string; timeoutMs?: number; maxDepth?: number; maxItems?: number; expectedPauseId?: string }): Promise<{ result: string; type: string | null; children: Variable[]; stale?: boolean; redacted?: boolean; redactionNotice?: string | null }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { result: '', type: null, children: [], stale: true };
        const s = this.session; if (!s) return { result: '', type: null, children: [] };
        if (this.svc._currentFrameId === null) {
            const frame = await this.getFrameByIndex(this.svc._currentFrameIndex);
            if (frame) this.svc._currentFrameId = frame.id;
        }
        try {
            const r = await this.withTimeout(Promise.resolve(s.customRequest('evaluate', { expression: opts.expression, frameId: this.svc._currentFrameId, context: 'repl' })), opts.timeoutMs ?? 3000);
            const body = r as any;
            const children: Variable[] = [];
            if (body.variablesReference > 0 && (opts.maxDepth ?? 0) > 0) {
                await this.collectVariables(s, body.variablesReference, children, opts.maxDepth ?? 0, 0, opts.maxItems ?? 50, new Set());
            }
            const red = redactExpressionResult(opts.expression, body.result ?? '');
            const childRed = redactVariables(children);
            const notice = (red.redacted || childRed.redacted) ? REDACTION_NOTICE : null;
            return { result: red.value, type: body.type ?? null, children: childRed.variables, redacted: red.redacted || childRed.redacted, redactionNotice: notice };
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
