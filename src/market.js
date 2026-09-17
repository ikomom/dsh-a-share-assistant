// 市场环境（复盘页用）：指数涨跌 + 概念板块涨跌排名 + 涨跌停情绪。
// 全部走 fuyao REST（GET + X-api-key）；板块排名用**一次批量** index-price-snapshot（390 个概念，分片 200）。
import { getData } from './fuyao.js';

const INDICES = [
  ['000001.SH', '上证指数'],
  ['399001.SZ', '深证成指'],
  ['399006.SZ', '创业板指'],
];

const pct2 = (v) => (v === null || v === undefined || v === '' ? null : Math.round(Number(v) * 100) / 100);
const shDate = (ms) => new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

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
    date: day, indices: [], indexDate: null,
    sectors: { gainers: [], losers: [], total: 0, catalog: 0, date: null },
    breadth: null, errors: [],
  };

  // ① 指数 + ③ 涨跌停情绪 + ④ 连板：并行
  const [idxRes, poolRes, ladderRes] = await Promise.allSettled([
    getData('index-price-snapshot', { thscodes: INDICES.map((x) => x[0]).join(',') }),
    Promise.all([getData('limit-up-pool', {}), getData('limit-down-pool', {}), getData('limit-break-pool', {})]),
    getData('limit-up-ladder', {}),
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
      date: up.timestamp ? shDate(up.timestamp) : null,
    };
  } else {
    ctx.errors.push(`涨跌停情绪: ${poolRes.reason?.message || poolRes.reason}`);
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
