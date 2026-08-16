import { DebuggerService } from './debuggerService';
import { FrameOps } from './frameOps';
import {
    PauseCapture, CaptureWatch, CaptureWatchResult,
    PauseCaptureStatus, PauseCaptureMetadata, Variable
} from './types';

/**
 * 暂停捕获系统（工具 33-41）：在每次调试器停止时自动捕获快照，
 * 支持 watch 表达式和按 captureId 检索历史捕获。
 */
export class PauseCaptureManager {
    private _active = false;
    private _watches: Map<string, CaptureWatch> = new Map();
    private _captures: Map<string, PauseCapture> = new Map();
    private _order: string[] = [];
    private _counter = 0;
    private readonly _maxCaptures = 100;
    private readonly _defaultMaxDepth = 1;
    private readonly _defaultMaxItems = 100;

    constructor(private readonly svc: DebuggerService) {}

    isActive(): boolean { return this._active; }

    // ═══ 33. debug_get_pause_capture_status ═══
    getStatus(): PauseCaptureStatus {
        return {
            active: this._active, watchCount: this._watches.size,
            captureCount: this._captures.size, maxCaptures: this._maxCaptures,
            defaultMaxDepth: this._defaultMaxDepth, defaultMaxItems: this._defaultMaxItems
        };
    }

    // ═══ 34. debug_set_pause_capture_active ═══
    setActive(active: boolean, expectedSolution: string): { active: boolean; message: string } {
        const wsCheck = this.svc.validateWorkspace(expectedSolution);
        if (!wsCheck.valid) return { active: this._active, message: wsCheck.error! };
        this._active = active;
        return { active, message: `Pause capture ${active ? 'activated' : 'deactivated'}` };
    }

    // ═══ 35. debug_add_capture_watch ═══
    addWatch(opts: { expression: string; function?: string; maxDepth?: number; maxItems?: number }): { watchId: string; effectiveMaxDepth: number; effectiveMaxItems: number } {
        const watchId = `watch-${++this._counter}-${Date.now().toString(36)}`;
        const maxDepth = Math.min(opts.maxDepth ?? this._defaultMaxDepth, 2);
        const maxItems = Math.min(opts.maxItems ?? 10, 50);
        this._watches.set(watchId, { watchId, expression: opts.expression, function: opts.function ?? null, maxDepth, maxItems });
        return { watchId, effectiveMaxDepth: maxDepth, effectiveMaxItems: maxItems };
    }

    // ═══ 36. debug_list_capture_watches ═══
    listWatches(): CaptureWatch[] { return Array.from(this._watches.values()); }

    // ═══ 37. debug_remove_capture_watch ═══
    removeWatch(watchId: string): { removed: boolean; message: string } {
        if (!this._watches.has(watchId)) return { removed: false, message: `Watch ${watchId} not found` };
        this._watches.delete(watchId);
        return { removed: true, message: `Watch ${watchId} removed` };
    }

    // ═══ 38. debug_get_latest_pause_capture ═══
    getLatest(): PauseCapture | null {
        if (this._order.length === 0) return null;
        return this._captures.get(this._order[this._order.length - 1]) ?? null;
    }

    // ═══ 39. debug_list_pause_captures ═══
    listCaptures(limit = 20): PauseCaptureMetadata[] {
        const result: PauseCaptureMetadata[] = [];
        const start = Math.max(0, this._order.length - limit);
        for (let i = this._order.length - 1; i >= start; i--) {
            const c = this._captures.get(this._order[i]);
            if (c) {
                result.push({
                    captureId: c.captureId, pauseId: c.pauseId, timestamp: c.timestamp,
                    reason: c.reason, threadId: c.threadId,
                    frameName: c.frame?.name ?? null, frameFile: c.frame?.source?.path ?? null,
                    frameLine: c.frame?.line ?? null
                });
            }
        }
        return result;
    }

    // ═══ 40. debug_get_pause_capture ═══
    getCapture(captureId: string): PauseCapture | null { return this._captures.get(captureId) ?? null; }

    // ═══ 41. debug_clear_pause_captures ═══
    clear(): { cleared: number; message: string } {
        const count = this._captures.size;
        this._captures.clear(); this._order = [];
        return { cleared: count, message: `Cleared ${count} captures` };
    }

    // ── 自动捕获（由 DAP stopped 事件触发）──
    async autoCapture(): Promise<void> {
        try { const c = await this.createCapture(); if (c) this.store(c); } catch { /* ignore */ }
    }

    private async createCapture(): Promise<PauseCapture | null> {
        const fo: FrameOps = this.svc.frames;
        const captureId = `capture-${++this._counter}-${Date.now().toString(36)}`;
        const callStack = await fo.getCallStack(50);
        const frame = callStack.length > 0 ? callStack[0] : null;
        let sourceContext: PauseCapture['sourceContext'] = null;
        if (frame?.source?.path) {
            sourceContext = await fo.getSourceContext({ frameIndex: 0, linesBefore: 30, linesAfter: 30, preferEditorBuffer: true });
        }
        let locals: Variable[] = []; let args: Variable[] = [];
        if (frame) { const r = await fo.getFrameLocals(0, this._defaultMaxDepth, this._defaultMaxItems); locals = r.locals; args = r.arguments; }
        const watchResults: CaptureWatchResult[] = [];
        for (const w of this._watches.values()) {
            try {
                const er = await fo.evaluate({ expression: w.expression, maxDepth: w.maxDepth, maxItems: w.maxItems });
                watchResults.push({ watchId: w.watchId, expression: w.expression, value: er.result, type: er.type, error: null, children: er.children });
            } catch (e: any) {
                watchResults.push({ watchId: w.watchId, expression: w.expression, value: '', type: null, error: e.message, children: [] });
            }
        }
        return {
            captureId, pauseId: this.svc._pauseId ?? '', timestamp: new Date().toISOString(),
            reason: this.svc._stopReason ?? 'unknown', threadId: this.svc._currentThreadId ?? 0,
            frame, callStack, sourceContext, locals, arguments: args, watches: watchResults
        };
    }

    private store(capture: PauseCapture): void {
        this._captures.set(capture.captureId, capture);
        this._order.push(capture.captureId);
        while (this._order.length > this._maxCaptures) {
            const old = this._order.shift()!;
            this._captures.delete(old);
        }
    }
}
