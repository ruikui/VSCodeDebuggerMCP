/**
 * 运行时秘密值的脱敏处理。
 *
 * 调试适配器会原样返回作用域内的所有变量，其中常包含 API key、token、
 * 密码以及整个 os.environ / process.env 的转储。这些值随后会被流式传输
 * 给 AI agent（通常还有远端模型提供商）。本模块在值离开扩展之前，对
 * 看起来像凭据的值进行擦除，使检查程序状态不会导致凭据外泄。
 *
 * 启发式规则在一个方向上刻意保守：空值、null-ish 或不含秘密材料的值
 * 保持原样，这样"为什么我的 token 是 undefined？"仍然可调试。
 */

import { Variable } from './types';

export const REDACTION_PLACEHOLDER = '<redacted: possible secret>';

export const REDACTION_NOTICE =
    `NOTE: values matching '${REDACTION_PLACEHOLDER}' were withheld because their name or ` +
    'content looks like a credential (key, token, password, connection string, ...). ' +
    'Use debug-specific checks (type, length, is-null) instead of reading the raw value.';

/**
 * 标记变量为凭据的名称。
 *
 * 精确匹配（大小写不敏感，忽略 `_`/`-` 分隔符）而非子串匹配：
 * 子串规则会标记任何仅包含 'token' 或 'cookie' 的名称，导致 tokenCount、
 * cookieCount 等良性变量被擦除而无法调试。
 *
 * 精确匹配的代价是任意复合名称不再被推断，因此广泛使用的复合形式
 * 在下方显式列出。
 */
const SENSITIVE_NAMES = new Set([
    // Keys
    'apikey', 'apikeys', 'apisecret', 'apisecretkey', 'accesskey', 'accesskeyid',
    'secretkey', 'secretaccesskey', 'privatekey', 'publicprivatekey', 'encryptionkey',
    'signingkey', 'sessionkey', 'masterkey', 'clientkey', 'sshkey', 'gpgkey', 'saskey',
    // Secrets
    'secret', 'secrets', 'clientsecret', 'consumersecret',
    // Passwords
    'password', 'passwords', 'passwd', 'pwd', 'pass', 'passphrase',
    'dbpassword', 'dbpasswd', 'dbpass', 'rootpassword', 'adminpassword', 'userpassword',
    // Tokens
    'token', 'tokens', 'accesstoken', 'refreshtoken', 'idtoken', 'authtoken', 'apitoken',
    'sessiontoken', 'bearertoken', 'bearer', 'oauthtoken', 'personalaccesstoken',
    'csrftoken', 'xsrftoken', 'sastoken', 'jwt',
    // Credentials / auth
    'credential', 'credentials', 'authorization', 'auth', 'otp',
    // Sessions and cookies
    'cookie', 'cookies', 'sessionid',
    // Connection strings
    'connectionstring', 'connstr', 'accountkey', 'sasurl',
    // Common environment-variable spellings
    'openaiapikey', 'anthropicapikey', 'awssecretaccesskey', 'awsaccesskeyid',
    'awssessiontoken', 'githubtoken', 'ghtoken', 'gitlabtoken', 'npmtoken', 'slacktoken',
    'azurestoragekey', 'googleapikey'
]);

/**
 * 将名称折叠为比较形式：大小写和 `_`/`-`/空格分隔符无意义，
 * 因此 `API_KEY`、`api-key` 和 `apiKey` 都是 `apikey`。
 */
function normalizeName(name: string): string {
    return name.toLowerCase().replace(/[\s_-]/g, '');
}

/**
 * 已知的凭据形状。无论变量名如何，这些都会被脱敏，
 * 因为赋值给 `x` 的秘密仍然是秘密。
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
    // PEM 块。body 用 base64/空白字符类匹配（而非 `[\s\S]*?`），
    // 使匹配无歧义且线性，且未终止的块仍会消费其密钥材料。
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*(?:-----END[A-Z ]*PRIVATE KEY-----)?/g,
    /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+/g,                     // JWTs
    /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{12,}\b/g,                            // AWS key ids
    /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,                                                // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    /\bxox[abopsr]-[A-Za-z0-9-]{10,}\b/g,                                             // Slack tokens
    /\bAIza[0-9A-Za-z_-]{30,}\b/g,                                                    // Google API keys
    /\bsk-(?:[A-Za-z0-9_-]+-)?[A-Za-z0-9]{16,}\b/g,                                   // OpenAI / Anthropic style
    /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}\b/g,                                      // Stripe
    /\bnpm_[A-Za-z0-9]{30,}\b/g,
    /\bglpat-[A-Za-z0-9_-]{16,}\b/g,                                                  // GitLab
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /\b(?:AccountKey|SharedAccessSignature|Password|Pwd)\s*=\s*[^;\s'"]+/gi           // connection strings
];

/** 不可能携带秘密、保持可读性用于调试的值。 */
const TRIVIAL_VALUES = new Set([
    '', 'none', 'null', 'nil', 'undefined', 'nan', 'true', 'false',
    '0', '-1', '[]', '{}', '()', 'empty', '<empty>'
]);

/** 引号/装饰剥离，使 `'None'` 和 `None` 被同等对待。 */
function unwrap(value: string): string {
    let text = value.trim();
    while (text.length >= 2 &&
        ((text.startsWith("'") && text.endsWith("'")) ||
            (text.startsWith('"') && text.endsWith('"')) ||
            (text.startsWith('`') && text.endsWith('`')))) {
        text = text.slice(1, -1).trim();
    }
    return text;
}

function isTrivialValue(value: string): boolean {
    return TRIVIAL_VALUES.has(unwrap(value).toLowerCase());
}

export function isSensitiveName(name: string | undefined | null): boolean {
    if (!name) {
        return false;
    }
    return SENSITIVE_NAMES.has(normalizeName(name));
}

export function looksLikeSecretValue(value: string | undefined | null): boolean {
    if (!value) {
        return false;
    }
    return SECRET_VALUE_PATTERNS.some(pattern => {
        pattern.lastIndex = 0;
        return pattern.test(value);
    });
}

/**
 * 基于变量名和内容脱敏单个变量值。
 * 返回（可能被改写的）值以及是否擦除了内容。
 *
 * 决策仅来自变量自身——其名称和值——绝不深入结构体的条目。
 * 名称不是凭据名称的结构体原样返回，即使其内部某字段叫 `password`；
 * 请直接检查该字段来擦除。
 */
export function redactVariableValue(name: string | undefined, value: unknown): { value: string; redacted: boolean } {
    const text = value === undefined || value === null ? '' : String(value);

    if (text === '' || isTrivialValue(text)) {
        return { value: text, redacted: false };
    }

    if (isSensitiveName(name)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    if (looksLikeSecretValue(text)) {
        // 可识别的凭据形状，无论变量叫什么。
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    return { value: text, redacted: false };
}

/**
 * 脱敏自由格式的调试器输出（例如 evaluate 结果），这是逐变量脱敏的
 * 平凡旁路：对 os.environ 或 process.env.API_KEY 执行 evaluate_expression
 * 会返回同样的秘密。
 */
export function redactExpressionResult(expression: string, value: unknown): { value: string; redacted: boolean } {
    const text = value === undefined || value === null ? '' : String(value);

    if (text === '' || isTrivialValue(text)) {
        return { value: text, redacted: false };
    }

    if (isSensitiveName(expression)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    if (looksLikeSecretValue(text)) {
        return { value: REDACTION_PLACEHOLDER, redacted: true };
    }

    return { value: text, redacted: false };
}

/**
 * 对变量数组应用脱敏，返回脱敏后的副本和是否有任何值被擦除。
 */
export function redactVariables(variables: Variable[]): { variables: Variable[]; redacted: boolean } {
    let anyRedacted = false;
    const out = variables.map(v => {
        const r = redactVariableValue(v.name, v.value);
        if (r.redacted) {
            anyRedacted = true;
            return { ...v, value: r.value };
        }
        return v;
    });
    return { variables: out, redacted: anyRedacted };
}
