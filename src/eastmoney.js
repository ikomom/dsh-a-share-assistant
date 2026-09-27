// 东方财富行情接口（**非官方**：网页端公开 JSON 接口，无公开文档、无授权声明）。
//
// 用途：补 fuyao 与问财都缺的「结构化分钟 K 线」——
//   · push2his /api/qt/stock/kline/get   分钟 K 线（klt=1/5/15/30/60；101/102/103 日/周/月）
//   · push2   /api/qt/stock/trends2/get  当日分时（多一列「均价」，即分时均线）
//
// 实测事实（2026-09，两份独立实测交叉核对；逐参数手册见 docs/eastmoney-api.md）：
//   · 必填：secid / fields1 / fields2 / klt / fqt（缺任一 → HTTP 200 + rc:102 + data:null）；**ut 可省略**
//   · 深度：klt=1 → 仅当日 240 根；klt=5 → 约最近 31 个交易日 1488 根；klt=15/30/60 → 同样窗口；日线一次可给 6012 根
//   · secid：沪（含科创板/沪 ETF/沪指数）=`1.`；深（含创业板/深指数）与**北交所**=`0.`（实测）；港股 `116.`、美股 `105.`
//   · trends2：241 点（09:30–15:00，121+120），**无集合竞价点、无 15:00 之后点位**；`ndays` 实测**被完全忽略**
//   · 字段列：本模块只取 f51…f58 = 日期,开,收,高,低,量(手),额(元),振幅%
//
// 已知坑（均为实测）：
//   ① **fqt 必填**：漏掉 fqt 直接 data=null（不是默认值）
//   ② **`lmt` 语义在两次实测中冲突**（带 `beg` 时被忽略返回整段；不带 `beg` 时一次实测按 N 截断、另一次报 rc:102）
//      → 本模块**不用 `lmt`**，改用双方都验证会返回数据的 `beg=0&end=20500101`（拿全段，再由 `--limit` 本地截取）
//   ③ **`beg` 的日期格式陷阱**：`beg=2023-08-01`（带横线）不报错但**静默返回全量**；本模块固定传 `beg=0`，不走用户输入
//   ④ fqt=1（前复权）的**早期日线是坏的**（茅台 2001-08-27 收 -312.47）→ 复权序列用 fqt=2；本项目只用它取分钟线
//   ⑤ `rc:0` 但 `klines:[]` 表示退市/代码已切换（`name` 带"(已切换)"）→ **必须判空并让降级链接手**（本模块已抛错）
//
// ⚠️ **端点级熔断（实测踩到）**：累计约 60 次请求后 `kline/get` 会被服务端直接断 TCP（`UND_ERR_SOCKET`），
//   持续 ≥10 分钟，且**非 IP 限流**（换出口 IP 也复现；同期 `trends2` 仍 200）。→ **不要轮询该端点**；
//   失败时由 CLI 的降级链自动转腾讯（见 src/tencent.js），再转问财。
//
// 风险：非官方接口，随时可能变更；仅建议个人自用。
import { getData } from './fuyao.js';

const UT = 'fa5fd1943c7b386f172d6893dbfba10b'; // 公开常量；实测可省略，保留以贴近网页端行为
const KLINE = 'https://push2his.eastmoney.com/api/qt/stock/kline/get';
const TRENDS = 'https://push2.eastmoney.com/api/qt/stock/trends2/get';
export const MINUTE_KLTS = [1, 5, 15, 30, 60];

/** 我们的 thscode（600519.SH / 300750.SZ / 510300.SH / 000001.SH）→ 东财 secid（1.600519） */
export function toSecid(thscode) {
  const m = /^(\d{6})\.(SH|SZ|BJ)$/i.exec(String(thscode || '').trim());
  if (!m) throw new Error(`thscode 形如 600519.SH / 300750.SZ（当前: ${thscode}；港股 116./美股 105. 前缀本项目未开放）`);
  const market = m[2].toUpperCase() === 'SH' ? '1' : '0'; // 沪=1；深/北=0（北交所实测为 0.，见 docs/eastmoney-api.md §6）
  return `${market}.${m[1]}`;
}

/** rc 语义（实测）：102=缺参/格式错；100=标的不存在或 klt 非法；0+空数组=退市/已切换 */
function rcHint(rc) {
  if (rc === 102) return '（rc=102：参数缺失或格式错误）';
  if (rc === 100) return '（rc=100：标的不存在，或 klt 等取值非法）';
  return '';
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
    if (!j || j.data == null) throw new Error(`${label}: 返回 data=null${rcHint(j?.rc)}`);
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
  // 用 beg=0&end=20500101 拿"该源能给的全段"（**不用 lmt**：其语义在两次实测中冲突），再由 --limit 本地截取
  const url = `${KLINE}?secid=${secid}&ut=${UT}&fields1=f1,f2,f3,f4,f5,f6`
    + `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=${k}&fqt=1&beg=0&end=20500101`;
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
  // rc:0 但空数组 = 退市/代码已切换（name 会带"(已切换)"）→ 抛错让降级链接手，别把空结果当成功
  if (!rows.length) throw new Error(`东财无数据（${secid}${data.name ? ` ${data.name}` : ''}：退市/代码已切换/停牌，或该周期无数据）`);
  const n = limit ? Math.max(1, Number(limit)) : rows.length;
  return { source: 'eastmoney(非官方)', secid, name: data.name ?? '', klt: k, total: rows.length, rows: rows.slice(-n) };
}

/**
 * 当日分时（含均价线）。
 * 注意：`ndays` 实测被完全忽略（ndays=1/2/3/5 返回字节数与点数完全相同，ndays=10 → rc:102），
 * 需要多日分时请走腾讯 `day/query`（CLI 的 --ndays>1 已自动改走腾讯）。
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
  if (!rows.length) throw new Error(`东财分时无数据（${secid}）`);
  return {
    source: 'eastmoney(非官方)', secid, name: data.name ?? '', prePrice: data.prePrice ?? null, total: rows.length, rows,
    notes: ['东财分时 241 点（09:30–15:00）：无集合竞价点、无 15:00 之后点位（对比腾讯有 15:06–15:30 盘后点）'],
  };
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
