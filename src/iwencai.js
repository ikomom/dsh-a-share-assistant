// 问财（iwencai）渠道：公告 / 新闻等**消息面**检索 —— fuyao API 没有的能力。
// 技能本体由 iwencai SkillHub 装在 ~/.agents/skills/<slug>/（Python 脚本，读 IWENCAI_API_KEY）。
// 本模块只做三件事：
//   ① 从 .a-share-assistant/config.json 注入 Key（不必配环境变量、不必重启 DSH）
//   ② 调脚本并把结果写临时文件回传（stdio 用 ignore，不依赖管道——沙箱下管道会 EPERM）
//   ③ 把网关原始 JSON 收敛成精简条目（正文截断，避免整篇公告灌进上下文）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getIwencaiKey, IWENCAI_BASE, CACHE_ROOT } from './config.js';

/** 支持的检索通道：channel → 技能 slug + 中文名 */
export const CHANNELS = {
  announcement: { slug: 'announcement-search', label: '公告' },
  news: { slug: 'news-search', label: '新闻/资讯' },
};

const SKILLS_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agents', 'skills');

/** 技能脚本路径：优先 <slug 下划线>.py，否则取 scripts/ 下第一个 .py（兼容后续技能命名） */
export function skillScript(slug) {
  const dir = path.join(SKILLS_ROOT, slug, 'scripts');
  const direct = path.join(dir, slug.replace(/-/g, '_') + '.py');
  if (fs.existsSync(direct)) return direct;
  try {
    const py = fs.readdirSync(dir).filter((f) => f.endsWith('.py')).sort();
    if (py.length) return path.join(dir, py[0]);
  } catch { /* 未安装 */ }
  return null;
}

/** 渠道可用性（供 check 展示；不暴露 Key 值） */
export function channelStatus() {
  const keyOk = Boolean(getIwencaiKey());
  return Object.entries(CHANNELS).map(([channel, meta]) => ({
    channel, label: meta.label, slug: meta.slug, keyOk, installed: Boolean(skillScript(meta.slug)),
  }));
}

/** python 解释器（可用 A_SHARE_PYTHON 覆盖） */
function pythonBin() {
  return process.env.A_SHARE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/** 收敛网关原始结果为精简条目 */
function normalize(body, summaryLimit = 400) {
  const list = Array.isArray(body?.data) ? body.data : [];
  return list.map((d) => ({
    date: d.publish_date || (d.publish_time ? new Date(Number(d.publish_time) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''),
    title: d.title || '',
    source: d.extra?.publish_source || d.extra?.real_publish_source || d.data_source || '',
    url: d.url || '',
    code: (d.stock_infos || []).map((s) => s.code).filter((c) => /^\d{6}$/.test(String(c))).join(','),
    summary: String(d.summary || '').replace(/\s+/g, ' ').slice(0, summaryLimit),
  }));
}

/**
 * 消息面检索。
 * @param {{channel:'announcement'|'news', query:string, size?:number, timeout?:number, includeRaw?:boolean, summaryLimit?:number}} opts
 * @returns {Promise<{channel,label,query,size,total,status,items:Array,raw?:string}>}
 */
export async function search({ channel, query, size = 10, timeout = 60, includeRaw = false, summaryLimit = 400 } = {}) {
  const meta = CHANNELS[channel];
  if (!meta) throw new Error(`未知渠道 ${channel}，可选：${Object.keys(CHANNELS).join(' | ')}`);
  const q = String(query ?? '').trim();
  if (!q) throw new Error('检索词不能为空（--q "<自然语言>"）');
  const key = getIwencaiKey();
  if (!key) {
    throw new Error('未配置问财 API Key。请在会话目录 .a-share-assistant/config.json 的 iwencai.apiKey（或环境变量 IWENCAI_API_KEY）中填写——Key 在 https://www.iwencai.com/skillhub 获取。');
  }
  const script = skillScript(meta.slug);
  if (!script) {
    throw new Error(`未安装技能 ${meta.slug}。安装：python <iwencai-skillhub-cli.py> --dir "%USERPROFILE%\\.agents\\skills" install ${meta.slug}`);
  }
  const rawFile = path.join(CACHE_ROOT, `iwencai-${channel}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  const args = [script, q, '--size', String(size), '--timeout', String(timeout), '--output', rawFile];
  const code = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(pythonBin(), args, {
        stdio: 'ignore',
        env: { ...process.env, IWENCAI_API_KEY: key, IWENCAI_BASE_URL: IWENCAI_BASE },
      });
    } catch { resolve(-1); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, (timeout + 20) * 1000);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('close', (c) => { clearTimeout(timer); resolve(c ?? -1); });
  });
  if (code !== 0 || !fs.existsSync(rawFile)) {
    if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true });
    throw new Error(`问财检索失败（python 退出码 ${code}）。常见原因：Key 无效/过期、网络不通、技能未装好、python 不在 PATH（可用 A_SHARE_PYTHON 指定）。`);
  }
  const raw = fs.readFileSync(rawFile, 'utf8');
  let body = null;
  try { body = JSON.parse(raw); } catch { /* 保留 raw 供排查 */ }
  const items = normalize(body, summaryLimit);
  if (!includeRaw) fs.rmSync(rawFile, { force: true });
  return {
    channel, label: meta.label, query: q, size,
    total: body?.total ?? items.length,
    status: body?.status_msg || null,
    items,
    ...(includeRaw ? { raw, rawFile } : {}),
  };
}
