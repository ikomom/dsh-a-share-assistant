// 腾讯财经（gtimg / ifzq）行情接口 —— **非官方**（网页端公开 JSON 接口）。
//
// 本文件里的**每一个参数与行为都来自实测**，实测手册见仓库 `docs/tencent-api.md`（40 次请求逐条留证）。
// 关键实测结论（照抄手册，勿凭常识改）：
//   · minute/query：`?code=sh600522`；行 = `HHMM 价格 累计量(手) 累计额(元)`（4 段，量额是**累计**）；
//     267 点 = 09:30–11:30(121) + 13:00–15:00(121) + **15:06–15:30(25，盘后成交，不计入日成交量)**；
//     无集合竞价点；`1300` 是 `1130` 的占位重复；**没有均价字段**（均价需自己按 额/(量×100) 算）。
//   · kline/mkline：`?param=<code>,<m1|m5|m15|m30|m60|m120>,,<条数>`；**第 3 段必须留空**（填值→静默空数组）；
//     **每周期硬上限 320 根**（传 100000 也只给 320）；行 = `[YYYYMMDDHHMM, 开, 收, 高, 低, 量(手), {}, 万分比换手]`；
//     无成交额、无均价；`day` 不支持（会 param error）。
//   · 错误语义：`mkline` 参数错 → `code:-1`；而 `fqkline` 参数错 → **`code:0` 但 `msg:"param error"`**；
//     不存在的代码 → `code:0` + 空数组（**必须自己判空**）。
//   · `Content-Type` 是 `text/html` 但 body 是 JSON（别用 Content-Type 判断）；无 Referer/UA 校验（仍带上）。
//   · 北交所（bj）K 线实测为空数组；美股需带交易所后缀（未核实）。
//
// 定位：作为**东财失败后的第二级降级**（东财覆盖更深，见 src/eastmoney.js）。
import { getData } from './fuyao.js';

const HOST_MINUTE = 'https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=';
const HOST_DAY = 'https://web.ifzq.gtimg.cn/appstock/app/day/query?code=';
const HOST_MKLINE = 'https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=';

/** 我们的 thscode（600519.SH）→ 腾讯 code（sh600519） */
export function toTencentCode(thscode) {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(String(thscode || '').trim());
  if (!m) throw new Error(`thscode 形如 600519.SH / 000001.SZ（当前: ${thscode}）`);
  const prefix = { SH: 'sh', SZ: 'sz', BJ: 'bj' }[m[2].toUpperCase()];
  return prefix + m[1];
}

/** 我们把项目里的分钟周期（1/5/15/30/60）映射为腾讯周期码；腾讯还支持 m120（本项目暂未开放） */
export const KLT_TO_TENCENT = { 1: 'm1', 5: 'm5', 15: 'm15', 30: 'm30', 60: 'm60' };
export const TENCENT_MKLINE_MAX = 320; // 实测：六个周期一律 320 根，传更大值被静默钳制

async function getJson(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://gu.qq.com/' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text(); // Content-Type 是 text/html，只能按文本读再 JSON.parse
    let j;
    try { j = JSON.parse(text); } catch { throw new Error(`${label}: 返回不是 JSON（前 80 字：${text.slice(0, 80)}）`); }
    if (j.code !== 0) throw new Error(`${label}: code=${j.code} msg=${j.msg || ''}`);
    if (j.msg) throw new Error(`${label}: msg=${j.msg}`); // 覆盖 fqkline 那种 code=0 + "param error"
    return j;
  } finally {
    clearTimeout(timer);
  }
}

const fmtTime = (hhmm) => `${String(hhmm).slice(0, 2)}:${String(hhmm).slice(2, 4)}`;
const fmtDate = (yyyymmdd) => `${String(yyyymmdd).slice(0, 4)}-${String(yyyymmdd).slice(4, 6)}-${String(yyyymmdd).slice(6, 8)}`;
const fmtStamp = (s) => (/^\d{12}$/.test(String(s))
  ? `${fmtDate(String(s).slice(0, 8))} ${fmtTime(String(s).slice(8, 12))}`
  : String(s));

/** 分时行（累计量额）→ 统一行对象：单分钟量额由累计差分得到 */
function parseMinuteLines(lines, date) {
  const rows = [];
  let prevV = 0;
  let prevT = 0;
  for (const line of lines) {
    const parts = String(line).trim().split(/\s+/);
    const [hhmm, price, cumVol, cumTurn] = parts;
    const v = Number(cumVol);
    const t = Number(cumTurn);
    rows.push({
      time: `${fmtDate(date)} ${fmtTime(hhmm)}`,
      close: Number(price),
      volumeLots: Math.round((v - prevV) * 100) / 100,
      turnoverCny: Math.round((t - prevT) * 100) / 100,
      cumVolumeLots: v,
      cumTurnoverCny: t,
      avgPrice: v > 0 ? Math.round((t / (v * 100)) * 1000) / 1000 : null,
      session: hhmm >= '1506' ? 'after' : hhmm > '1130' && hhmm < '1300' ? 'lunch' : hhmm <= '1130' ? 'am' : 'pm',
      ...(hhmm === '1300' ? { placeholder: true } : {}),
    });
    prevV = v;
    prevT = t;
  }
  return rows;
}

const TX_NOTES = [
  '腾讯分时只有「价格 + 累计量 + 累计额」4 列：单分钟量额是差分算出来的，均价由 额/(量×100) 算出，没有 OHLC',
  '15:06–15:30 的 25 个点是盘后成交（价格恒为收盘价，不计入日成交量），做指标时应剔除 session=after',
  '1300 那个点是 1130 的占位重复（三字段完全相同）',
];

/** 当日分时（minute/query） */
export async function fetchTrends({ thscode } = {}) {
  const code = toTencentCode(thscode);
  const j = await getJson(HOST_MINUTE + code, `腾讯分时 ${code}`);
  const node = j.data?.[code];
  const lines = node?.data?.data ?? [];
  if (!lines.length) throw new Error(`腾讯分时无数据（${code}：北交所/美股/无成交标的会返回空数组）`);
  const date = node.data.date;
  const rows = parseMinuteLines(lines, date);
  return {
    source: 'tencent(非官方)', code, name: node?.qt?.[code]?.[1] ?? '', date,
    ohlc: false, total: rows.length, rows, notes: TX_NOTES,
  };
}

/** 多日分时（day/query：实测固定最近 5 个交易日 × 267 点）——东财没有这个能力 */
export async function fetchMultiDayTrends({ thscode, days = 5 } = {}) {
  const code = toTencentCode(thscode);
  const j = await getJson(HOST_DAY + code, `腾讯多日分时 ${code}`);
  const node = j.data?.[code];
  const list = Array.isArray(node?.data) ? node.data : [];
  if (!list.length) throw new Error(`腾讯多日分时无数据（${code}）`);
  const pick = list.slice(-Math.max(1, Number(days) || 5));
  const daysOut = pick.map((d) => ({ date: fmtDate(d.date), prec: Number(d.prec) || null, rows: parseMinuteLines(d.data ?? [], d.date) }));
  const rows = daysOut.flatMap((d) => d.rows);
  return {
    source: 'tencent(非官方)', code, name: node?.qt?.[code]?.[1] ?? '',
    ohlc: false, days: daysOut.length, availableDays: list.length, total: rows.length, rows,
    perDay: daysOut.map((d) => ({ date: d.date, points: d.rows.length })),
    notes: [...TX_NOTES, `day/query 实测固定返回最近 ${list.length} 个交易日（本次取 ${daysOut.length} 天）`],
  };
}

/** 分钟 K 线（mkline） */
export async function fetchMinuteKline({ thscode, klt = 5, limit } = {}) {
  const tag = KLT_TO_TENCENT[Number(klt)];
  if (!tag) {
    throw new Error(`腾讯 mkline 只支持 ${Object.keys(KLT_TO_TENCENT).join('/')} 分钟（实测 m120 也有，但本项目未开放）`);
  }
  const code = toTencentCode(thscode);
  // 第 3 段必须留空（填值会静默返回空数组）；条数上限 320，传更大值无效
  const j = await getJson(`${HOST_MKLINE}${code},${tag},,${TENCENT_MKLINE_MAX}`, `腾讯${tag} ${code}`);
  const node = j.data?.[code];
  const arr = Array.isArray(node?.[tag]) ? node[tag] : [];
  if (!arr.length) {
    throw new Error(`腾讯 ${tag} 无数据（${code}：北交所/美股会返回空；第 3 段必须留空，填了也会空）`);
  }
  const rows = arr.map((r) => ({
    time: fmtStamp(r[0]),
    open: Number(r[1]), close: Number(r[2]), high: Number(r[3]), low: Number(r[4]),
    volumeLots: Number(r[5]),
    turnoverCny: null,                                        // 腾讯 mkline 不提供成交额
    turnoverRatePct: r[7] === undefined ? null : Math.round((Number(r[7]) / 100) * 10000) / 10000, // [7] 是万分比换手 → 转百分比并修掉浮点尾数
  }));
  const n = limit ? Math.max(1, Number(limit)) : rows.length;
  return {
    source: 'tencent(非官方)', code, name: node?.qt?.[code]?.[1] ?? '', klt: Number(klt),
    ohlc: true, maxBars: TENCENT_MKLINE_MAX, total: rows.length, rows: rows.slice(-n),
    notes: [
      `腾讯 mkline 每周期硬上限 ${TENCENT_MKLINE_MAX} 根（传更大值被静默钳制，不报错）`,
      '腾讯 mkline 不提供成交额：只有成交量(手) 与万分比换手（turnoverRatePct = [7]/100）',
    ],
  };
}

/** 供 CLI check 用的轻量探活（取 m5 的 1 根，顺带验证 code 解析） */
export async function tencentProbe(thscode = '600519.SH') {
  const r = await fetchMinuteKline({ thscode, klt: 5, limit: 1 });
  return { ok: r.rows.length > 0, detail: `${r.name} m5 共 ${r.total} 根（上限 ${TENCENT_MKLINE_MAX}）` };
}

// 预留：腾讯没有复权因子接口，日线复权走 fqkline（本项目日线仍以 fuyao 为准），故此处不使用 getData
void getData;
