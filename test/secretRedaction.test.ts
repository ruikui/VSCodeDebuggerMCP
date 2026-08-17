/**
 * secretRedaction 脱敏逻辑单元测试（纯函数，不依赖 vscode 运行时）。
 */
import {
    isSensitiveName,
    looksLikeSecretValue,
    redactVariableValue,
    redactExpressionResult,
    redactVariables,
    REDACTION_PLACEHOLDER
} from '../src/secretRedaction';
import { Variable } from '../src/types';

let passed = 0;
let failed = 0;

function assert(cond: boolean, label: string): void {
    if (cond) { console.log(`  [PASS] ${label}`); passed++; }
    else { console.error(`  [FAIL] ${label}`); failed++; }
}

function makeVar(name: string, value: string): Variable {
    return { name, value, type: 'string', variablesReference: 0 };
}

export async function run(): Promise<{ passed: number; failed: number }> {
    console.log('\n--- secretRedaction 脱敏单元测试 ---');

    // ── isSensitiveName ──
    console.log('  [组] 敏感名称识别');
    assert(isSensitiveName('password') === true, 'password 是敏感名');
    assert(isSensitiveName('PASSWORD') === true, 'PASSWORD 大小写不敏感');
    assert(isSensitiveName('api_key') === true, 'api_key 分隔符归一化');
    assert(isSensitiveName('api-key') === true, 'api-key 分隔符归一化');
    assert(isSensitiveName('apiKey') === true, 'apiKey 驼峰归一化');
    assert(isSensitiveName('token') === true, 'token 是敏感名');
    assert(isSensitiveName('tokenCount') === false, 'tokenCount 非敏感（精确匹配，不误伤）');
    assert(isSensitiveName('cookieCount') === false, 'cookieCount 非敏感');
    assert(isSensitiveName('username') === false, 'username 非敏感');
    assert(isSensitiveName('') === false, '空字符串非敏感');
    assert(isSensitiveName(undefined) === false, 'undefined 非敏感');
    assert(isSensitiveName(null as any) === false, 'null 非敏感');

    // ── looksLikeSecretValue ──
    console.log('  [组] 凭据形状识别');
    assert(looksLikeSecretValue('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U') === true, 'JWT 被识别');
    assert(looksLikeSecretValue('AKIAIOSFODNN7EXAMPLE') === true, 'AWS Access Key ID 被识别');
    assert(looksLikeSecretValue('sk-abcdefghijklmnopqrstuvwxyz123456') === true, 'OpenAI 风格 key 被识别');
    assert(looksLikeSecretValue('ghp_0123456789abcdef0123456789abcdef0123') === true, 'GitHub token 被识别');
    assert(looksLikeSecretValue('-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----') === true, 'PEM 私钥被识别');
    assert(looksLikeSecretValue('hello world') === false, '普通文本非凭据');
    assert(looksLikeSecretValue('') === false, '空字符串非凭据');
    assert(looksLikeSecretValue(undefined) === false, 'undefined 非凭据');

    // ── redactVariableValue ──
    console.log('  [组] 变量值脱敏');
    assert(redactVariableValue('password', 'hunter2').redacted === true, '按名称脱敏 password');
    assert(redactVariableValue('password', 'hunter2').value === REDACTION_PLACEHOLDER, '脱敏值替换为占位符');
    assert(redactVariableValue('username', 'john').redacted === false, '非敏感名/值不脱敏');
    assert(redactVariableValue('x', 'sk-abcdefghijklmnopqrstuvwxyz123456').redacted === true, '按形状脱敏（无论变量名）');
    assert(redactVariableValue('x', 'null').redacted === false, '平凡值 null 不脱敏');
    assert(redactVariableValue('token', '').redacted === false, '空值不脱敏');
    assert(redactVariableValue(undefined, 'secret').redacted === false, '无名称且非凭据形状不脱敏');

    // ── redactExpressionResult ──
    console.log('  [组] 表达式结果脱敏');
    assert(redactExpressionResult('process.env.API_KEY', 'sk-abcdefghijklmnopqrstuvwxyz123456').redacted === true, '表达式值含凭据形状被脱敏');
    assert(redactExpressionResult('password', 'anything').redacted === true, '表达式名为敏感名被脱敏');
    assert(redactExpressionResult('count', '42').redacted === false, '普通表达式不脱敏');

    // ── redactVariables ──
    console.log('  [组] 变量数组脱敏');
    {
        const vars: Variable[] = [
            makeVar('password', 'hunter2'),
            makeVar('count', '42'),
            makeVar('api_key', 'abc123')
        ];
        const r = redactVariables(vars);
        assert(r.redacted === true, '数组整体标记 redacted');
        assert(r.variables[0].value === REDACTION_PLACEHOLDER, 'password 值被擦除');
        assert(r.variables[1].value === '42', 'count 保持原样');
        assert(r.variables[2].value === REDACTION_PLACEHOLDER, 'api_key 值被擦除');
    }
    {
        const r2 = redactVariables([makeVar('name', 'alice'), makeVar('age', '30')]);
        assert(r2.redacted === false, '无凭据数组不标记 redacted');
        assert(r2.variables[0].value === 'alice', '原值保留');
    }

    console.log(`  [小结] 本组 ${passed} 通过, ${failed} 失败`);
    return { passed, failed };
}
