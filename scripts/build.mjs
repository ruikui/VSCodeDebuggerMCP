#!/usr/bin/env node
/**
 * 构建脚本：编译 TypeScript → ESLint → 打包 VSIX
 *
 * 用法：
 *   node scripts/build.mjs              # 编译 + lint + 打包
 *   node scripts/build.mjs --no-package  # 仅编译 + lint
 *   node scripts/build.mjs --lint-only   # 仅 lint
 */
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(cmd, label) {
    console.log(`\n[${label}] ${cmd}`);
    try {
        execSync(cmd, { cwd: root, stdio: 'inherit' });
        console.log(`[${label}] OK`);
        return true;
    } catch {
        console.error(`[${label}] FAILED`);
        return false;
    }
}

console.log('=== VSCodeDebuggerMCP Build ===');

const args = process.argv.slice(2);
const lintOnly = args.includes('--lint-only');
const noPackage = args.includes('--no-package');

// 1. ESLint
if (!run('npx eslint src --ext ts', 'lint')) {
    console.error('Lint failed. Fix errors before packaging.');
    if (!args.includes('--force')) process.exit(1);
}

if (lintOnly) {
    console.log('\n=== Lint-only complete ===');
    process.exit(0);
}

// 2. 编译 TypeScript
if (!run('npx tsc -p ./', 'compile')) {
    console.error('Compilation failed.');
    process.exit(1);
}

// 3. 打包 VSIX
if (!noPackage) {
    if (!run('npx vsce package --no-git-tag-version', 'package')) {
        console.error('Packaging failed. Install vsce: npm i -g @vscode/vsce');
    }
}

console.log('\n=== Build complete ===');
