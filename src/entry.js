#!/usr/bin/env node
// A股助手 CLI 入口（防御壳）：业务模块加载失败时给出明确指引，而不是裸 SyntaxError。
// package.json 的 bin 指向本文件；开发/会话内仍可用 `node src/cli.js`（加载失败会裸崩，属开发态）。
try {
  await import('./cli.js');
} catch (e) {
  console.error('✗ A股助手 CLI 加载失败：插件文件可能被更新/损坏，或模块导出不匹配。');
  console.error(`  原因: ${e.message}`);
  console.error('  修复: 重跑 install-preset.js；若仍在开发中，请确认 src/ 下各文件能正常相互 import。');
  process.exit(1);
}