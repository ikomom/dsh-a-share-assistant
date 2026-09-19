// 路径与配置：系统产物统一放「会话工作目录/.a-share-assistant」文件夹
//   读取链 = 环境变量 > {cwd}/.a-share-assistant/config.json（首次自动从示例生成）> 项目 config.example.json
//   敏感值（apiKey）只存在于 .a-share-assistant/config.json（git 忽略），项目内不落密钥。
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE_CONFIG_PATH = path.join(PROJECT_ROOT, 'config.example.json');

/** 系统产物根目录：{A_SHARE_HOME 或 会话 cwd}/.a-share-assistant */
export function homeDir() {
  const base = path.resolve(process.env.A_SHARE_HOME || process.cwd());
  return path.join(base, '.a-share-assistant');
}

export function userConfigPath() {
  return path.join(homeDir(), 'config.json');
}

/** 用户配置文件完整路径（模块加载时解析，供 CLI 展示/创建） */
export const USER_CONFIG_PATH = userConfigPath();

function readJsonSafe(file) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch {
    return null;
  }
}

function loadConfig() {
  // 只读加载：不自动生成、不打印引导（生成决策交给 CLI 的 config 子命令，先问用户）
  return readJsonSafe(userConfigPath()) || {};
}

/** 用户配置文件是否已存在 */
export function isConfigPresent() {
  return fs.existsSync(userConfigPath());
}

const cfg = loadConfig();

/** 配置来源（供 check/安装脚本展示），不暴露任何值 */
export function getConfigSource() {
  return fs.existsSync(userConfigPath()) ? userConfigPath() : '项目 config.example.json（兜底）';
}

// 缓存根目录：环境变量 > 用户配置 > 默认（系统产物根/cache）
export const CACHE_ROOT = path.resolve(
  process.env.A_SHARE_CACHE_DIR || cfg.cacheRoot || path.join(homeDir(), 'cache')
);

// 笔记库根目录（仅作"参照"：判断会话 cwd 是否为笔记库，用于工作目录提醒）。
// 笔记（用户产物）按产品原则写入会话 cwd，不走此路径。
// 未配置时返回 null（显式未配置状态，不静默回退 cwd，避免掩盖问题）。
export const NOTES_ROOT = (() => {
  const v = process.env.A_SHARE_NOTE_ROOT || cfg.noteRoot || cfg.vaultRoot; // 兼容旧字段 vaultRoot
  return typeof v === 'string' && v.trim() ? path.resolve(v) : null;
})();

// ── 复盘目录（复盘笔记 + 持仓分析报告 的落盘位置）────────────────────────────
// 解析顺序：环境变量 A_SHARE_REVIEW_DIR > 配置 reviewDir（相对 noteRoot 或绝对）> 自动探测 > {cwd}/复盘
// 自动探测：{noteRoot 或 cwd}/学习/金融/复盘（本机实际放复盘笔记的位置）→ 存在就用它。
// 目的：让 复盘笔记 YYYY-MM-DD.md 与 报告 持仓分析/xxx.html 永远在同一目录，不再分家。
export function reviewDir() {
  const asPath = (base, p) => (path.isAbsolute(p) ? p : path.join(base, p));
  const envDir = process.env.A_SHARE_REVIEW_DIR;
  if (envDir && envDir.trim()) return path.resolve(envDir);
  const base = NOTES_ROOT || path.resolve(process.cwd());
  const cfgDir = cfg.reviewDir;
  if (typeof cfgDir === 'string' && cfgDir.trim()) return asPath(base, cfgDir.trim());
  const candidates = [
    path.join(base, '学习', '金融', '复盘'),
    path.join(path.resolve(process.cwd()), '学习', '金融', '复盘'),
    path.join(base, '复盘'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch { /* 不存在就试下一个 */ }
  }
  return path.join(path.resolve(process.cwd()), '复盘');
}

export const FUYAO_BASE = cfg.fuyao?.baseUrl || 'https://fuyao.aicubes.cn';

// API Key：环境变量优先，其次用户配置；值绝不输出到日志/回复
export function getApiKey() {
  const envKey = process.env.FUYAO_API_KEY || process.env.A_SHARE_API_KEY;
  if (envKey) return envKey;
  const cfgKey = cfg.fuyao?.apiKey;
  return typeof cfgKey === 'string' && cfgKey.trim() ? cfgKey : null;
}

// ── 问财（iwencai）渠道：公告 / 新闻等消息面数据源 ──────────────────────────
// 技能由 iwencai SkillHub 装在 ~/.agents/skills/<slug>/；Key 只从环境变量或本配置读，不落仓库
export const IWENCAI_BASE = cfg.iwencai?.baseUrl || 'https://openapi.iwencai.com';

export function getIwencaiKey() {
  const envKey = process.env.IWENCAI_API_KEY;
  if (envKey) return envKey;
  const cfgKey = cfg.iwencai?.apiKey;
  return typeof cfgKey === 'string' && cfgKey.trim() ? cfgKey : null;
}

export function getWatchlist() {
  return Array.isArray(cfg.watchlist) ? cfg.watchlist : [];
}

// ── 交易费率（A股，默认；可在 config 的 feeProfiles 里按账户覆盖）─────────────
const DEFAULT_FEE = {
  commissionRate: 0.00025,   // 佣金 万2.5（双向）
  commissionMin: 5,          // 单笔佣金最低 5 元
  stampTaxRate: 0.0005,      // 印花税 0.05%（仅卖出）
  transferFeeRate: 0.00001,  // 过户费 0.001%（双向）
};

export function getFeeProfile(name) {
  const profs = cfg.feeProfiles || {};
  return profs?.[name] || profs?.default || DEFAULT_FEE;
}

