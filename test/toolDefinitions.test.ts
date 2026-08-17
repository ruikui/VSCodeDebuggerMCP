/**
 * 工具定义完整性测试（纯数据校验，不依赖 vscode 运行时）。
 * 验证重构后的工具拆分/合并/新增是否符合预期。
 */
import { ToolDefinitions, ToolMap } from '../src/toolDefinitions';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) { console.log(`  [PASS] ${label}`); passed++; }
    else { console.error(`  [FAIL] ${label}`); failed++; }
}

const names = new Set(ToolDefinitions.map(t => t.name));

export async function run(): Promise<{ passed: number; failed: number }> {
    console.log('\n--- 工具定义完整性测试 ---');

    console.log('  [组] 基础完整性');
    assert(ToolDefinitions.length > 0, `共定义 ${ToolDefinitions.length} 个工具`);
    assert(names.size === ToolDefinitions.length, '工具名无重复');
    assert(ToolMap && Object.keys(ToolMap).length === ToolDefinitions.length, 'ToolMap 与 ToolDefinitions 一致');

    console.log('  [组] 新增工具存在性');
    assert(names.has('debug_verify_target'), 'debug_verify_target 已恢复');
    assert(names.has('debug_start_test'), 'debug_start_test 已新增');
    assert(names.has('debug_get_variables_by_name'), 'debug_get_variables_by_name 已新增');
    assert(names.has('debug_get_broker_status'), 'debug_get_broker_status 已新增');
    assert(names.has('debug_list_instances'), 'debug_list_instances 已新增');
    assert(names.has('debug_step_into'), 'debug_step_into 已拆分');
    assert(names.has('debug_step_over'), 'debug_step_over 已拆分');
    assert(names.has('debug_step_out'), 'debug_step_out 已拆分');

    console.log('  [组] 已合并接口应移除');
    assert(!names.has('debug_step'), 'debug_step 已拆分移除');
    assert(!names.has('debug_get_locals'), 'debug_get_locals 已合并移除');
    assert(!names.has('debug_get_current_frame'), 'debug_get_current_frame 已合并移除');
    assert(!names.has('debug_get_latest_pause_capture'), 'debug_get_latest_pause_capture 已合并移除');
    assert(!names.has('debug_get_instance_info'), 'debug_get_instance_info 已合并移除');
    assert(!names.has('debug_get_stop_reason'), 'debug_get_stop_reason 已合并移除');

    console.log('  [组] debug_verify_target 必需字段');
    {
        const t = ToolMap['debug_verify_target'];
        const required = (t.inputSchema as any).required as string[];
        assert(!!t, 'debug_verify_target 定义存在');
        assert(required.includes('engine'), 'engine 为必需字段');
        assert(required.includes('expectedExecutable'), 'expectedExecutable 为必需字段');
        assert(required.includes('expectedSolution'), 'expectedSolution 为必需字段');
        assert(!required.includes('processId'), 'processId 非必需（可用 processName 替代）');
    }

    console.log('  [组] debug_get_variables_by_name 最小权限约束');
    {
        const t = ToolMap['debug_get_variables_by_name'];
        const namesProp = (t.inputSchema as any).properties?.names;
        assert(!!t, 'debug_get_variables_by_name 定义存在');
        assert((t.inputSchema as any).required.includes('names'), 'names 为必需字段');
        assert(namesProp?.maxItems === 50, 'names maxItems 限制为 50');
        assert(namesProp?.type === 'array', 'names 类型为 array');
    }

    console.log('  [组] 步进工具拆分语义');
    {
        const into = ToolMap['debug_step_into'];
        const over = ToolMap['debug_step_over'];
        const out = ToolMap['debug_step_out'];
        assert(into.description.includes('Step Into'), 'debug_step_into 语义正确');
        assert(over.description.includes('Step Over'), 'debug_step_over 语义正确');
        assert(out.description.includes('Step Out'), 'debug_step_out 语义正确');
        assert((into.inputSchema as any).required.includes('expectedPauseId'), 'debug_step_into 要求 expectedPauseId');
    }

    console.log('  [组] 所有工具均有 name/description/inputSchema');
    {
        const allValid = ToolDefinitions.every(t =>
            typeof t.name === 'string' && t.name.length > 0 &&
            typeof t.description === 'string' && t.description.length > 0 &&
            t.inputSchema && typeof t.inputSchema === 'object'
        );
        assert(allValid, '每个工具都有完整的 name/description/inputSchema');
    }

    console.log(`  [小结] 本组 ${passed} 通过, ${failed} 失败`);
    return { passed, failed };
}
