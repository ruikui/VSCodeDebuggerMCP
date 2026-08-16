import * as vscode from 'vscode';
import { DebuggerService } from './debuggerService';
import { FrameOps } from './frameOps';
import {
    DataBreakpointInfo, ModuleInfo, DisassemblyInstruction,
    RegisterGroup, MemoryReadResult, SourceMapEntry
} from './types';

/**
 * 高级调试操作（工具 42-49）：数据断点、模块、反汇编、寄存器、内存、源码映射。
 */
export class AdvancedDebugOps {
    private _dataBreakpoints: Map<string, DataBreakpointInfo> = new Map();
    private _dataBpCounter = 0;

    constructor(private readonly svc: DebuggerService) {}

    private get session(): vscode.DebugSession | undefined { return this.svc.getActiveSession(); }

    // ═══ 42. debug_add_data_breakpoint ═══
    async addDataBreakpoint(opts: { expression: string; dataCount?: number; expectedPauseId?: string }): Promise<{ tag: string; verified: boolean; message: string; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { tag: '', verified: false, message: v.error!, stale: true };
        const s = this.session; if (!s) return { tag: '', verified: false, message: 'No active session' };
        const fo: FrameOps = this.svc.frames;
        await fo.evaluate({ expression: opts.expression, maxDepth: 0, maxItems: 1 });
        let dataId: string | null = null;
        try {
            const frame = await fo.getFrameByIndex(this.svc._currentFrameIndex);
            if (frame) {
                const r = await s.customRequest('dataBreakpointInfo', { variablesReference: 0, name: opts.expression, frameId: frame.id });
                dataId = (r as any)?.dataId ?? null;
            }
        } catch { /* adapter may not support */ }
        if (!dataId) dataId = opts.expression;
        let verified = false; let message = '';
        try {
            const r = await s.customRequest('setDataBreakpoints', { breakpoints: [{ dataId, accessType: 'write' }] });
            const bps = (r as any)?.breakpoints ?? [];
            verified = bps.length > 0 && bps[0].verified;
            message = bps[0]?.message ?? '';
        } catch (e: any) { verified = false; message = `Adapter does not support data breakpoints: ${e.message}`; }
        const tag = `dbp-${++this._dataBpCounter}-${Date.now().toString(36)}`;
        this._dataBreakpoints.set(tag, { tag, expression: opts.expression, dataId, accessType: 'write', dataCount: opts.dataCount ?? 4, enabled: true, verified, message: message || null });
        return { tag, verified, message };
    }

    // ═══ 43. debug_manage_breakpoint_by_tag ═══
    async manageByTag(opts: { tag: string; action: 'enable' | 'disable' | 'remove' }): Promise<{ managed: boolean; message: string }> {
        const bp = this._dataBreakpoints.get(opts.tag);
        if (!bp) return { managed: false, message: `Data breakpoint ${opts.tag} not found` };
        const s = this.session;
        if (opts.action === 'remove') {
            this._dataBreakpoints.delete(opts.tag);
            if (s) { try { const rem = Array.from(this._dataBreakpoints.values()).filter(b => b.enabled && b.dataId).map(b => ({ dataId: b.dataId, accessType: b.accessType })); await s.customRequest('setDataBreakpoints', { breakpoints: rem }); } catch {} }
            return { managed: true, message: `Data breakpoint ${opts.tag} removed` };
        }
        bp.enabled = opts.action === 'enable';
        if (s) { try { const en = Array.from(this._dataBreakpoints.values()).filter(b => b.enabled && b.dataId).map(b => ({ dataId: b.dataId, accessType: b.accessType })); await s.customRequest('setDataBreakpoints', { breakpoints: en }); } catch {} }
        return { managed: true, message: `Data breakpoint ${opts.tag} ${opts.action}d` };
    }

    // ═══ 44. debug_list_modules ═══
    async listModules(opts: { nameFilter?: string; nativeOnly?: boolean; limit?: number }): Promise<ModuleInfo[]> {
        const s = this.session; if (!s) return [];
        try {
            const r = await s.customRequest('loadedSources');
            let sources = (r as any)?.sources ?? [];
            if (opts.nameFilter) { const f = opts.nameFilter.toLowerCase(); sources = sources.filter((m: any) => (m.name ?? '').toLowerCase().includes(f)); }
            return sources.slice(0, opts.limit ?? 100).map((m: any) => ({ id: m.id ?? 0, name: m.name ?? '', path: m.path ?? null, sourceReference: m.sourceReference ?? 0, symbolStatus: m.symbolStatus ?? null, isOptimized: m.isOptimized ?? null, isUserCode: m.isUserCode ?? null, version: m.version ?? null }));
        } catch { return []; }
    }

    // ═══ 45. debug_get_disassembly ═══
    async getDisassembly(opts: { frameIndex?: number; instructionCount?: number; expectedPauseId?: string }): Promise<{ instructions: DisassemblyInstruction[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { instructions: [], stale: true };
        const s = this.session; if (!s) return { instructions: [] };
        const fo: FrameOps = this.svc.frames;
        const frame = await fo.getFrameByIndex(opts.frameIndex ?? 0);
        if (!frame?.instructionPointerReference) return { instructions: [] };
        try {
            const r = await s.customRequest('disassemble', { memoryReference: frame.instructionPointerReference, offset: 0, instructionCount: opts.instructionCount ?? 50, resolveSymbols: true });
            const instrs = (r as any)?.instructions ?? [];
            return { instructions: instrs.map((i: any) => ({ address: i.address ?? '', instruction: i.instruction ?? '', line: i.line ?? null, column: i.column ?? null, endLine: i.endLine ?? null, endColumn: i.endColumn ?? null, symbol: i.symbol ?? null, sourceFile: i.location?.path ?? null })) };
        } catch { return { instructions: [] }; }
    }

    // ═══ 46. debug_get_registers ═══
    async getRegisters(opts: { frameIndex?: number; expectedPauseId?: string }): Promise<{ groups: RegisterGroup[]; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { groups: [], stale: true };
        const s = this.session; if (!s) return { groups: [] };
        const fo: FrameOps = this.svc.frames;
        const frame = await fo.getFrameByIndex(opts.frameIndex ?? 0);
        if (!frame) return { groups: [] };
        try {
            const r = await s.customRequest('registers', { frameId: frame.id });
            const groups = (r as any)?.registers ?? (r as any)?.groups ?? [];
            if (Array.isArray(groups) && groups.length > 0 && groups[0].name !== undefined) {
                return { groups: groups.map((g: any) => ({ name: g.name, registers: (g.registers ?? g.values ?? []).map((r: any) => ({ name: r.name ?? r.key ?? '', value: r.value ?? '', memoryReference: r.memoryReference })) })) };
            }
            if (Array.isArray(groups)) {
                return { groups: [{ name: 'Registers', registers: groups.map((r: any) => ({ name: r.name ?? '', value: r.value ?? '', memoryReference: r.memoryReference })) }] };
            }
            return { groups: [] };
        } catch { return { groups: [] }; }
    }

    // ═══ 47. debug_read_memory ═══
    async readMemory(opts: { expression: string; byteCount?: number; bytesPerRow?: number; frameIndex?: number; expectedPauseId?: string }): Promise<{ result: MemoryReadResult | null; message: string; stale?: boolean }> {
        const v = this.svc.validatePauseIdOptional(opts.expectedPauseId);
        if (!v.valid) return { result: null, message: v.error!, stale: true };
        const s = this.session; if (!s) return { result: null, message: 'No active session' };
        const fo: FrameOps = this.svc.frames;
        let memoryRef: string | null = null;
        try {
            const frame = await fo.getFrameByIndex(opts.frameIndex ?? 0);
            if (frame) {
                const r = await s.customRequest('evaluate', { expression: opts.expression, frameId: frame.id, context: 'watch' });
                memoryRef = (r as any)?.memoryReference ?? null;
                if (!memoryRef && typeof (r as any)?.result === 'string') memoryRef = (r as any).result;
            }
        } catch {}
        if (!memoryRef) return { result: null, message: 'Could not resolve memory reference' };
        const byteCount = opts.byteCount ?? 64;
        const bytesPerRow = opts.bytesPerRow ?? 16;
        try {
            const r = await s.customRequest('readMemory', { memoryReference: memoryRef, offset: 0, count: byteCount });
            const base64Data = (r as any)?.data ?? '';
            const raw = Buffer.from(base64Data, 'base64');
            const hex: string[] = []; const ascii: string[] = [];
            for (let i = 0; i < raw.length; i += bytesPerRow) {
                const slice = raw.slice(i, i + bytesPerRow);
                hex.push(Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join(' '));
                ascii.push(Array.from(slice).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join(''));
            }
            return { result: { address: memoryRef, byteCount: raw.length, bytesPerRow, hex, ascii, raw: raw.toString('hex') }, message: `Read ${raw.length} bytes` };
        } catch (e: any) { return { result: null, message: `Failed to read memory: ${e.message}` }; }
    }

    // ═══ 48. debug_set_source_map ═══
    setSourceMap(opts: { mappings: SourceMapEntry[]; replace?: boolean }): { count: number; message: string } {
        if (opts.replace ?? true) this.svc._sourceMaps.length = 0;
        for (const m of opts.mappings) this.svc._sourceMaps.push({ from: m.from, to: m.to });
        return { count: opts.mappings.length, message: `Set ${opts.mappings.length} source map(s)` };
    }

    // ═══ 49. debug_list_source_maps ═══
    listSourceMaps(): SourceMapEntry[] {
        return [...this.svc._sourceMaps];
    }
}
