#!/usr/bin/env node
// 安装 A股助手 preset 到 DSH 用户目录：
//   复制 presets/a-share-assistant → ~/.dsh/.agent-presets/a-share-assistant
//   替换 __PROJECT_ROOT__ / __CACHE_ROOT__ / __VAULT_ROOT__ / __SKILL_MD__ 占位符
//   运行时配置（cacheRoot/vaultRoot/apiKey）读用户态 ~/.dsh/a-share-assistant.json，
//   首次安装自动从 config.example.json 生成并引导填写。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ── 前置检查与平台探测 ───────────────────────────────────────────────────────
const nodeMajor = Number(process.version.slice(1).split('.')[0]);
if (nodeMajor < 18) {
  console.error(`✗ 需要 Node.js >= 18，当前 ${process.version}`);
  process.exit(1);
}
const PLATFORM = process.platform; // 'win32' | 'linux' | 'darwin' | ...
const PLATFORM_NOTE = PLATFORM === 'win32'
  ? '本机 PowerShell/curl 的 schannel TLS 不可用，取数一律走后端 node fetch，勿用 Invoke-WebRequest / curl'
  : '统一走后端 node fetch 取数最稳；Linux/macOS 下若要临时用 curl 亦可，但建议走 CLI';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRESET_ID = 'a-share-assistant';
const SRC_DIR = path.join(PROJECT_ROOT, 'presets', PRESET_ID);
const DEST_DIR = path.join(os.homedir(), '.dsh', '.agent-presets', PRESET_ID);
// 系统产物根：{A_SHARE_HOME 或 cwd}/.a-share-assistant（与 src/config.js 的 homeDir 一致）
const USER_CFG = path.join(path.resolve(process.env.A_SHARE_HOME || process.cwd()), '.a-share-assistant', 'config.json');
const EXAMPLE_CFG = path.join(PROJECT_ROOT, 'config.example.json');

// ── 用户配置：只读；缺失时不自动生成（先问后建原则），提示用 cli config 创建 ──
let config = null;
if (fs.existsSync(USER_CFG)) {
  config = JSON.parse(fs.readFileSync(USER_CFG, 'utf8'));
} else {
  console.log(`⚠️ 未检测到配置文件: ${USER_CFG}`);
  console.log('   安装继续，但请先创建配置：node src/cli.js config（交互询问）或 config --init / config --template');
  console.log('');
  config = {}; // 空配置：占位符回退到未配置状态
}

const CACHE_ROOT = String(config.cacheRoot || path.join(path.resolve(process.env.A_SHARE_HOME || process.cwd()), '.a-share-assistant', 'cache')).replace(/\//g, path.sep);
const VAULT_ROOT = (typeof config.vaultRoot === 'string' && config.vaultRoot.trim())
  ? config.vaultRoot
  : null; // 未配置则不替换为路径，persona 中显示"未配置"

function replacer(text) {
  return text
    .replaceAll('__PROJECT_ROOT__', PROJECT_ROOT)
    .replaceAll('__CACHE_ROOT__', CACHE_ROOT)
    .replaceAll('__VAULT_ROOT__', VAULT_ROOT || '（未配置 vaultRoot，工作目录提醒关闭）')
    .replaceAll('__PLATFORM_NOTE__', PLATFORM_NOTE)
    .replaceAll('__SKILL_MD__', path.join(DEST_DIR, 'skills', 'a-share-assistant', 'SKILL.md'));
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (/\.(yml|md|json|mjs)$/.test(entry.name)) {
      fs.writeFileSync(d, replacer(fs.readFileSync(s, 'utf8')));
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// 防御：绝不允许覆盖官方内置目录
if (DEST_DIR.includes(path.join('@deepseek-ai', 'dsh', 'config'))) {
  console.error('拒绝安装：目标路径疑似官方内置目录');
  process.exit(1);
}

if (fs.existsSync(DEST_DIR)) {
  console.log(`已存在 ${DEST_DIR}，执行覆盖安装...`);
}
copyDir(SRC_DIR, DEST_DIR);
console.log(`✔ 已安装预设: ${DEST_DIR}`);
console.log(`  项目根: ${PROJECT_ROOT}`);
console.log(`  配置来源: ${USER_CFG}`);
console.log(`  缓存目录: ${CACHE_ROOT}`);
console.log(`  vault 根: ${VAULT_ROOT}`);
console.log(`  平台: ${PLATFORM}（${PLATFORM_NOTE}）`);
console.log('');
console.log('支持矩阵：Windows（本机已验证）/ Linux、macOS（代码跨平台兼容，建议安装后先跑 `node src/cli.js check` 自检）');
console.log('下一步：在 DSH Web 界面「新建会话」→ 预设选择「A股助手」。');
console.log('提示：当前已打开的会话不会热切换预设，需要新建会话生效。');