// 东方财富行情接口（**非官方**：网页端公开 JSON 接口，无公开文档、无授权声明）。
//
// 用途：补 fuyao 与问财都缺的「结构化分钟 K 线」——
//   · push2his /api/qt/stock/kline/get   分钟 K 线（klt=1/5/15/30/60；101/102/103 日/周/月）
//   · push2   /api/qt/stock/trends2/get  当日分时（多一列「均价」，即分时均线）
//
// 实测（2026-09-24，本机直连可用、无需鉴权）：
//   klt=1  → 仅当日 240 根；klt=5 → 最近 ≈31 个交易日 1488 根；klt=15/30/60 → 同样窗口
//   ETF/指数同样支持（510300 → secid 1.510300；上证指数 → 1.000001）
//
// 已知坑：
//   ① fqt=1（前复权）的**早期日线是坏的**（茅台 2001-08-27 收盘 -312.47）—— 复权序列请用 fqt=2（后复权）
//   ② lmt 不是硬行数上限（klt=5&lmt=6 仍返回整段）—— 按返回内容截取，别依赖它
//
// 风险：接口随时可能变更/限流；仅建议个人自用。插件侧默认在失败时回退问财 `search --channel market --series`。
import { getData } from './fuyao.js';

const UT = 'fa5fd1943c7b386f172d6893dbfba10b'; // 网页端公开常量
const KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TRENDS = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
export const MINUTE_KLTS = [1, 5, 15, 30, 60];

/** 我们的 thscode（600519.SH / 300750.SZ / 510300.SH / 000001.SH）→ 东财 secid（1.600519） */
export function toSecid(thscode) {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(String(thscode || '').trim());
  if (!m) throw new Error(`thscode 形如 600519.SH / 300750.SZ（当前: ${thscode}）`);
  const market = m[2].toUpperCase() === 'SH' ? '1' : '0'; // 沪=1；深/北=0（北交所未实测）
  return `${market}.${m[1]}`;
}

async function getJson(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (!j || j.data == null) throw new Error(`${label}: 接口返回 data=null（代码/参数可能有误）`);
    return j.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 分钟 K 线（OHLCV + 振幅）。
 * @param {{thscode:string, klt?:number, limit?:number}} opts klt 见 MINUTE_KLTS；limit 为返回末尾条数（本地截取）
 * @returns {Promise<{source:string, secid:string, name:string, klt:number, rows:Array<object>}>}
 */
export async function fetchMinuteKline({ thscode, klt = 5, limit } = {}) {
  const k = Number(klt);
  if (!MINUTE_KLTS.includes(k)) throw new Error(`klt 只支持 ${MINUTE_KLTS.join('/')}（分钟）；日/周/月请用 fuyao price-historical`);
  const secid = toSecid(thscode);
  const url = `${KLINE}?secid=${secid}&ut=${UT}&fields1=f1,f2,f3,f4,f5,f6`
    + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=${k}&fqt=1&beg=0&end=20500101&lmt=10000`;
  const data = await getJson(url, `东财分钟K线 ${secid}`);
  const raw = data.klines ?? [];
  const rows = raw.map((line) => {
    const [time, open, close, high, low, volume, turnover, amplitudePct] = String(line).split(',');
    return {
      time,
      open: Number(open), close: Number(close), high: Number(high), low: Number(low),
      volumeLots: Number(volume), turnoverCny: Number(turnover), amplitudePct: Number(amplitudePct),
    };
  });
  const n = limit ? Math.max(1, Number(limit)) : rows.length;
  return { source: 'eastmoney(非官方)', secid, name: data.name ?? '', klt: k, total: rows.length, rows: rows.slice(-n) };
}

/**
 * 当日分时（含均价线）。
 * @returns {Promise<{source:string, secid:string, name:string, prePrice:number|null, rows:Array<object>}>}
 */
export async function fetchTrends({ thscode, ndays = 1 } = {}) {
  const secid = toSecid(thscode);
  const url = `${TRENDS}?secid=${secid}&ut=${UT}`
    + `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13&fields2=f51,f52,f53,f54,f55,f56,f57,f58`
    + `&ndays=${Number(ndays) || 1}&iscr=0&iscca=0`;
  const data = await getJson(url, `东财分时 ${secid}`);
  const rows = (data.trends ?? []).map((line) => {
    const [time, open, close, high, low, volume, turnover, avgPrice] = String(line).split(',');
    return {
      time,
      open: Number(open), close: Number(close), high: Number(high), low: Number(low),
      volumeLots: Number(volume), turnoverCny: Number(turnover), avgPrice: Number(avgPrice),
    };
  });
  return { source: 'eastmoney(非官方)', secid, name: data.name ?? '', prePrice: data.prePrice ?? null, total: rows.length, rows };
}

/**
 * 降级：东财失败时用问财分时（`search --channel market --series`）顶一下。
 * 口径更弱（只有收盘价等单值、无 OHLC），返回结构统一为 {time, close} 并标 degraded。
 */
export async function fallbackIwencaiSeries({ thscode, klt = 1 } = {}) {
  const ticker = String(thscode || '').split('.')[0];
  const grain = Number(klt) === 1 ? '每分钟' : `每${Number(klt)}分钟`;
  const query = `${ticker} 今日9:30到15:00${grain}收盘价`;
  const { search } = await import('./iwencai.js');
  const r = await search({ channel: 'market', query, size: 1, series: true });
  if (!r.series) throw new Error('问财回退也没拿到分时序列');
  const field = r.series.fields.find((f) => /收盘价/.test(f)) ?? r.series.fields[0];
  return {
    source: 'iwencai(降级，仅收盘价)', query, field, total: r.series.points,
    rows: r.series.series.map((p) => ({ time: `${p.date} ${p.time}`, close: Number(p[field]) })),
  };
}

/** 供 CLI check 用：一次轻量探活（取 1 根 5 分钟线） */
export async function eastmoneyProbe(thscode = '600519.SH') {
  const r = await fetchMinuteKline({ thscode, klt: 5, limit: 1 });
  return { ok: r.rows.length > 0, detail: r.rows.length ? `${r.name} klt=5 共 ${r.total} 根` : '无数据' };
}

// 让 lint/打包器不因未使用 import 报错（getData 预留给未来的复权因子/快照补充）
void getData;
