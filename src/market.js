// 市场环境（复盘页用）：指数涨跌 + 概念板块涨跌排名 + 涨跌停情绪 + 全市场涨跌家数。
// 全部走 fuyao REST（GET + X-api-key）；板块排名用**一次批量** index-price-snapshot（390 个概念，分片 200）。
import { getData, fetchAllMarketSnapshot } from './fuyao.js';

const INDICES = [
  ['000001.SH', '上证指数'],
  ['399001.SZ', '深证成指'],
  ['399006.SZ', '创业板指'],
];

const pct2 = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100) / 100);
const shDate = (ms) => new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * 解析"最近交易日"（<= 目标日的最后一个交易日）。
 * 必要性：涨停/跌停/炸板池省略 date_ms 时按**服务端当前自然日**取，周末与节假日会返回空池，
 * 复盘时会得出"涨停 0 家"这种误导性结论。交易日历的 date 是 YYYYMMDD，date_ms 是当日零点 ms。
 * @returns {Promise<{date:string, ms:number, isTradingDay:boolean}|null>}
 */
export async function resolveTradingDay(date) {
  const day = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const res = await getData('trading-days', {});
  const items = res?.data?.item ?? [];
  const days = items
    .map((x) => ({ ms: Number(x.date_ms), date: shDate(x.date_ms) }))
    .filter((x) => Number.isFinite(x.ms))
    .sort((a, b) => a.ms - b.ms);
  const upto = days.filter((x) => x.date <= day);
  const pick = upto[upto.length - 1] ?? days[days.length - 1] ?? null;
  return pick ? { date: pick.date, ms: pick.ms, isTradingDay: pick.date === day } : null;
}

/**
 * 全市场涨跌家数（广度）：一次全市场快照（~5500 只、1.2MB）+ 本地聚合，**只返回统计值**。
 * 复盘里"普涨/普跌"就看这个，比板块口径更接近体感。
 */
export async function fetchMarketBreadth() {
  const snap = await fetchAllMarketSnapshot();
  const items = snap?.data?.item ?? [];
  if (!items.length) throw new Error('全市场快照为空（接口未返回 item）');
  let up = 0, down = 0;
  for (const x of items) {
    const c = Number(x.price_change);
    if (c > 0) up++;
    else if (c < 0) down++;
  }
  return {
    total: items.length, up, down, flat: items.length - up - down,
    date: snap?.data?.timestamp ? shDate(snap.data.timestamp) : null,
  };
}

/** 按代码批量取指数/板块行情（分片避免 URL 过长） */
async function indexQuotes(codes, chunk = 200) {
  const out = [];
  for (let i = 0; i < codes.length; i += chunk) {
    const res = await getData('index-price-snapshot', { thscodes: codes.slice(i, i + chunk).join(',') });
    if (res && res.code !== undefined && res.code !== 0) throw new Error(`code=${res.code} ${res.message}`);
    out.push(...(res?.data?.item ?? []));
  }
  return out;
}

/**
 * 取当日市场环境。任何一块失败都不影响其他块，失败信息进 errors（调用方需如实展示）。
 * @param {{date?: string, sectorTop?: number}} opts date=YYYY-MM-DD（默认今天，Asia/Shanghai）
 */
export async function fetchMarketContext({ date, sectorTop = 8 } = {}) {
  const day = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const ctx = {
    date: day, tradeDate: day, isTradingDay: null, indices: [], indexDate: null,
    sectors: { gainers: [], losers: [], total: 0, catalog: 0, date: null },
    breadth: null, marketBreadth: null, errors: [],
  };

  // 先定"最近交易日"：涨停池等接口省略 date_ms 时按自然日取，周末会空
  let td = null;
  try {
    td = await resolveTradingDay(day);
    if (td) { ctx.tradeDate = td.date; ctx.isTradingDay = td.isTradingDay; }
  } catch (e) {
    ctx.errors.push(`交易日历: ${e.message}`);
  }
  const poolParams = td ? { date_ms: String(td.ms) } : {};

  // ① 指数 + ③ 涨跌停情绪 + ④ 连板 + ⑤ 全市场广度：并行
  const [idxRes, poolRes, ladderRes, mbRes] = await Promise.allSettled([
    getData('index-price-snapshot', { thscodes: INDICES.map((x) => x[0]).join(',') }),
    Promise.all([getData('limit-up-pool', poolParams), getData('limit-down-pool', poolParams), getData('limit-break-pool', poolParams)]),
    getData('limit-up-ladder', {}),
    fetchMarketBreadth(),
  ]);

  if (idxRes.status === 'fulfilled') {
    const d = idxRes.value?.data ?? {};
    const items = d.item ?? [];
    ctx.indices = INDICES.map(([code, name]) => {
      const it = items.find((x) => x.thscode === code || String(x.ticker) === code.split('.')[0]);
      return it
        ? { code, name, last: num(it.last_price), change: num(it.price_change), changePct: pct2(it.price_change_ratio_pct), turnoverCny: num(it.turnover) }
        : { code, name, last: null, change: null, changePct: null, turnoverCny: null };
    });
    ctx.indexDate = d.timestamp ? shDate(d.timestamp) : null;
  } else {
    ctx.errors.push(`指数行情: ${idxRes.reason?.message || idxRes.reason}`);
  }

  if (poolRes.status === 'fulfilled') {
    const [up, dn, br] = poolRes.value.map((r) => r?.data ?? {});
    const n = (d) => (d.item ?? []).length;
    const limitUp = n(up), limitBreak = n(br);
    const denom = limitUp + limitBreak;
    ctx.breadth = {
      limitUp, limitDown: n(dn), limitBreak,
      sealRate: denom ? Math.round((limitUp / denom) * 1000) / 10 : null,
      date: td?.date ?? (up.timestamp ? shDate(up.timestamp) : null),
      note: ctx.isTradingDay === false ? `非交易日：涨停池取最近交易日 ${td?.date ?? '—'} 的数据` : null,
    };
  } else {
    ctx.errors.push(`涨跌停情绪: ${poolRes.reason?.message || poolRes.reason}`);
  }

  if (mbRes.status === 'fulfilled') {
    const mb = mbRes.value;
    // 标签用交易日（快照 timestamp 在周末仍显示当天，会让"涨跌家数"看起来是周末数据）
    ctx.marketBreadth = { ...mb, snapshotDate: mb.date, date: td ? td.date : mb.date };
  } else {
    ctx.errors.push(`全市场涨跌家数: ${mbRes.reason?.message || mbRes.reason}`);
  }

  if (ladderRes.status === 'fulfilled') {
    const items = ladderRes.value?.data?.item ?? [];
    const today = items.find((x) => x.date === day) ?? items[items.length - 1];
    const boards = today?.boards ?? {};
    let maxBoard = 0, maxBoardNames = [];
    for (const list of Object.values(boards)) {
      for (const s of list ?? []) {
        const b = Number(s.board_num) || 0;
        if (b > maxBoard) { maxBoard = b; maxBoardNames = [s.name]; }
        else if (b === maxBoard && b > 0) maxBoardNames.push(s.name);
      }
    }
    ctx.ladder = { date: today?.date ?? null, maxBoard, maxBoardNames: maxBoardNames.slice(0, 5) };
  } else {
    ctx.errors.push(`连板天梯: ${ladderRes.reason?.message || ladderRes.reason}`);
  }

  // ② 概念板块：目录（含名称）→ 批量行情 → 排名
  try {
    const cat = await getData('ths-index-list', { tag: 'cn_concept' });
    const names = new Map((cat?.data?.item ?? []).map((x) => [x.thscode, x.name]));
    ctx.sectors.catalog = names.size;
    ctx.sectors.date = cat?.data?.timestamp ? shDate(cat.data.timestamp) : null;
    const items = await indexQuotes([...names.keys()]);
    const rows = items
      .map((it) => ({
        code: it.thscode,
        name: names.get(it.thscode) || it.thscode,
        changePct: pct2(it.price_change_ratio_pct),
        last: num(it.last_price),
        turnoverCny: num(it.turnover),
      }))
      .filter((x) => x.changePct !== null);
    rows.sort((a, b) => b.changePct - a.changePct);
    ctx.sectors.total = rows.length;
    ctx.sectors.gainers = rows.slice(0, sectorTop);
    ctx.sectors.losers = rows.slice(-sectorTop).reverse(); // 跌幅最大在前
    ctx.sectors.flatLine = rows.length ? { up: rows.filter((x) => x.changePct > 0).length, down: rows.filter((x) => x.changePct < 0).length } : null;
  } catch (e) {
    ctx.errors.push(`概念板块: ${e.message}`);
  }
  return ctx;
}
