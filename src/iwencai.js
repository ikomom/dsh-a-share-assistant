// 问财（iwencai）渠道：公告 / 新闻 / 研报 / 选股 / 行情 / 财务 / 事件 / 股东 / 机构评级 / 宏观 / 指数 /
// 板块 / 行业 / 基本资料 / 经营 / ETF / 可转债 —— fuyao API 没有的**消息面与筛选类**数据。
//
// 技能本体由 iwencai SkillHub 装在 ~/.agents/skills/<slug>/（Python 脚本，读 IWENCAI_API_KEY）。
// 本模块负责：
//   ① 从 .a-share-assistant/config.json 注入 Key（不必配环境变量、不必重启 DSH）
//   ② 兼容两种技能脚本形态：
//        A 形态（search 家族：announcement-search / news-search / report-search）
//           `python scripts/<name>.py "<query>" --size N --output <file>`（脚本自己写文件）
//        B 形态（hithink-* 家族，脚本统一是 scripts/cli.py）
//           `python scripts/cli.py --query "<query>" --limit N`（JSON 打到 stdout）
//      两种都用「文件」回传，不开管道——沙箱下管道会 EPERM。
//   ③ 统一归一化：A 形态 → {date,title,source,url,summary}；B 形态 → 原样表格行（datas）+ 列名
//   ④ Windows 编码：Python 重定向 stdout 时默认按 GBK，必须强制 UTF-8（PYTHONIOENCODING/PYTHONUTF8）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getIwencaiKey, IWENCAI_BASE, CACHE_ROOT } from './config.js';

/** 渠道别名 → 技能 slug（别名只是给人用的短名；也允许直接传 slug） */
export const CHANNELS = {
  announcement: { slug: 'announcement-search', label: '公告' },
  news: { slug: 'news-search', label: '新闻/资讯' },
  report: { slug: 'report-search', label: '研报' },
  astock: { slug: 'hithink-astock-selector', label: '选股' },
  market: { slug: 'hithink-market-query', label: '行情' },
  finance: { slug: 'hithink-finance-query', label: '财务' },
  event: { slug: 'hithink-event-query', label: '事件(预告/质押/解禁)' },
  holder: { slug: 'hithink-management-query', label: '股东股本' },
  research: { slug: 'hithink-insresearch-query', label: '机构评级/预测' },
  macro: { slug: 'hithink-macro-query', label: '宏观' },
  index: { slug: 'hithink-zhishu-query', label: '指数' },
  sector: { slug: 'hithink-sector-selector', label: '板块筛选' },
  industry: { slug: 'hithink-industry-query', label: '行业' },
  profile: { slug: 'hithink-basicinfo-query', label: '基本资料' },
  business: { slug: 'hithink-business-query', label: '经营数据' },
  etf: { slug: 'hithink-etf-selector', label: 'ETF 筛选' },
  cb: { slug: 'hithink-cb-selector', label: '可转债筛选' },
};

const SKILLS_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || '', '.agents', 'skills');

/** 技能脚本路径：优先 <slug 下划线>.py，否则取 scripts/ 下第一个 .py（hithink-* 统一是 cli.py） */
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

/**
 * 解析渠道：先查别名表，查不到就把入参当技能 slug（这样以后新装技能不用改代码）。
 * @returns {{key:string, slug:string, label:string}|null}
 */
export function resolveChannel(value) {
  const v = String(value ?? '').trim();
  if (!v) return null;
  if (CHANNELS[v]) return { key: v, ...CHANNELS[v] };
  if (skillScript(v)) return { key: v, slug: v, label: v };
  return null;
}

/** 渠道可用性（供 check 汇总；不暴露 Key 值） */
export function channelStatus() {
  const keyOk = Boolean(getIwencaiKey());
  const rows = Object.entries(CHANNELS).map(([channel, meta]) => ({
    channel, label: meta.label, slug: meta.slug, keyOk, installed: Boolean(skillScript(meta.slug)),
  }));
  return { keyOk, rows, installed: rows.filter((r) => r.installed).length, total: rows.length, missing: rows.filter((r) => !r.installed) };
}

function pythonBin() {
  return process.env.A_SHARE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
}

/** 判断脚本形态：参数里有 --query 的是 hithink-* 家族（B），否则是位置参数家族（A） */
function interfaceOf(script) {
  try {
    return /--query/.test(fs.readFileSync(script, 'utf8')) ? 'flags' : 'positional';
  } catch {
    return 'positional';
  }
}

/**
 * 把问财的「动态列宽表」转成按时间升序的**分时序列**。
 * 问财返回分时数据时不是行式，而是每列一个时间点：`收盘价[20260922 15:00:00]`、
 * `5分钟线收盘价[…]`、`成交量[…]`，且**按时间倒序**排列。这里解析成一行一个时间点。
 * @returns {{fields:string[], points:number, truncated:boolean, series:Array<object>}|null}
 *   null = 该行没有动态列（说明这次结果不是分时类）
 */
export function pivotSeries(row, { maxPoints = 2000 } = {}) {
  if (!row || typeof row !== 'object') return null;
  const re = /^(.+?)\[(\d{8}) (\d{2}:\d{2}:\d{2})\]$/;
  const points = new Map();
  const fields = new Set();
  for (const [k, v] of Object.entries(row)) {
    const m = re.exec(k);
    if (!m) continue;
    const [, field, date, time] = m;
    fields.add(field);
    const key = `${date} ${time}`;
    if (!points.has(key)) points.set(key, { values: {} });
    points.get(key).values[field] = v;
  }
  if (!points.size) return null;
  const list = [...points.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, p]) => {
      const [date, time] = key.split(' ');
      return { ts: key, date, time, ...p.values };
    });
  const truncated = list.length > maxPoints;
  return { fields: [...fields], points: list.length, truncated, series: truncated ? list.slice(-maxPoints) : list };
}

/** 归一化：A 形态（公告/新闻/研报）取 data[]；B 形态（hithink-*）取 datas[] 表格 */
function normalize(body, size, summaryLimit = 400) {
  if (!body || typeof body !== 'object') return { items: [], rowCount: 0, columns: [] };
  if (Array.isArray(body.datas)) {
    const rows = body.datas;
    const columns = rows.length && rows[0] && typeof rows[0] === 'object' ? Object.keys(rows[0]) : [];
    return {
      items: rows.slice(0, size).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'string' && v.length > summaryLimit ? v.slice(0, summaryLimit) : v]))),
      rowCount: Number(body.code_count ?? rows.length),
      returned: Number(body.returned_count ?? rows.length),
      hasMore: Boolean(body.has_more),
      columns,
    };
  }
  const list = Array.isArray(body.data) ? body.data : [];
  return {
    items: list.slice(0, size).map((d) => ({
      date: d.publish_date || (d.publish_time ? new Date(Number(d.publish_time) * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ''),
      title: d.title || '',
      source: d.extra?.publish_source || d.extra?.real_publish_source || d.data_source || '',
      url: d.url || '',
      code: (d.stock_infos || []).map((s) => s.code).filter((c) => /^\d{6}$/.test(String(c))).join(','),
      summary: String(d.summary || '').replace(/\s+/g, ' ').slice(0, summaryLimit),
    })),
    rowCount: Number(body.total ?? list.length),
  };
}

/**
 * 问财渠道检索。
 * @param {{channel:string, query:string, size?:number, timeout?:number, includeRaw?:boolean}} opts
 *   channel 可用别名（见 CHANNELS）或技能 slug；query 用自然语言（问财支持问句）
 */
export async function search({ channel, query, size = 10, timeout = 60, includeRaw = false, series: seriesWanted = false } = {}) {
  const ch = resolveChannel(channel);
  if (!ch) {
    throw new Error(`未知渠道 ${channel}。可用别名：${Object.keys(CHANNELS).join(' | ')}（也可直接传已安装的技能 slug）`);
  }
  const q = String(query ?? '').trim();
  if (!q) throw new Error('检索词不能为空（--q "<自然语言问句>"）');
  const key = getIwencaiKey();
  if (!key) {
    throw new Error('未配置问财 API Key。请在会话目录 .a-share-assistant/config.json 的 iwencai.apiKey（或环境变量 IWENCAI_API_KEY）中填写——Key 在 https://www.iwencai.com/skillhub 获取。');
  }
  const script = skillScript(ch.slug);
  if (!script) {
    throw new Error(`未安装技能 ${ch.slug}（技能目录 ~/.agents/skills）。安装：
  node <项目>/scripts/install-iwencai-skills.mjs --skills ${ch.slug}
技能与 Key 的获取入口：https://www.iwencai.com/skillhub`);
  }

  const rawFile = path.join(CACHE_ROOT, `iwencai-${ch.key}-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(rawFile), { recursive: true });
  const iface = interfaceOf(script);
  const args = iface === 'flags'
    ? [script, '--query', q, '--limit', String(size)]
    : [script, q, '--size', String(size), '--timeout', String(timeout), '--output', rawFile];
  const env = {
    ...process.env,
    IWENCAI_API_KEY: key,
    IWENCAI_BASE_URL: IWENCAI_BASE,
    // Windows 下 Python 重定向 stdout 会按 locale(GBK) 编码，中文会乱码 → 强制 UTF-8
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  const code = await new Promise((resolve) => {
    let fd = null;
    let child;
    try {
      const stdio = iface === 'flags'
        ? ['ignore', (fd = fs.openSync(rawFile, 'w')), 'ignore']   // 直接把子进程 stdout 接到文件
        : ['ignore', 'ignore', 'ignore'];                          // A 形态用 --output 自己写
      child = spawn(pythonBin(), args, { stdio, env });
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, (timeout + 20) * 1000);
    child.on('error', () => { clearTimeout(timer); if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } resolve(-1); });
    child.on('close', (c) => {
      clearTimeout(timer);
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
      resolve(c ?? -1);
    });
  });

  if (code !== 0 || !fs.existsSync(rawFile) || fs.statSync(rawFile).size === 0) {
    if (fs.existsSync(rawFile)) fs.rmSync(rawFile, { force: true });
    throw new Error(`问财检索失败（python 退出码 ${code}）。常见原因：Key 无效/过期、网络不通、技能未装好、python 不在 PATH（可用 A_SHARE_PYTHON 指定）。`);
  }
  const raw = fs.readFileSync(rawFile, 'utf8');
  let body = null;
  try { body = JSON.parse(raw); } catch { /* 保留 raw 供排查 */ }
  const norm = normalize(body, size);
  if (!includeRaw) fs.rmSync(rawFile, { force: true });
  // 分时：问财把分钟数据摊成"每列一个时间点"的宽表，这里转成正序序列（仅当调用方要 series）
  const series = seriesWanted ? pivotSeries(norm.items[0]) : undefined;
  return {
    channel: ch.key, label: ch.label, skill: ch.slug, query: q, size,
    total: norm.rowCount ?? norm.items.length,
    columns: norm.columns ?? [],
    items: norm.items,
    ...(series ? { series } : {}),
    ...(includeRaw ? { raw, rawFile } : {}),
  };
}
