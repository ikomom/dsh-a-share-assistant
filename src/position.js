// 交易台账：记录本金、建仓、加仓、减仓/清仓、现金/逆回购，供复盘与持仓盈亏计算。
// 数据存 {cwd}/.a-share-assistant/portfolio[.<account>].json（敏感，git 忽略）。
// 精度：金额/价格/手续费/盈亏内部一律用"分"（整数）运算，展示 formatYuan → 无浮点误差。
// 备份：每次写入前自动复制一份 .bak（防误删/损坏）。
import fs from 'node:fs';
import path from 'node:path';
import { getData } from './fuyao.js';
import { homeDir, getFeeProfile } from './config.js';
import { toCents, formatYuan, toMilli, formatMilli, milliTimesSharesToCents } from './money.js';

const FILE_NAME = 'portfolio.json';

/** 按账户返回台账文件（account 缺省为默认）。 */
export function portfolioFile(account) {
  const safe = account && String(account).replace(/[^\w\u4e00-\u9fa5-]/g, '_');
  const name = safe ? `portfolio.${safe}.json` : FILE_NAME;
  return path.join(homeDir(), name);
}

function ensureDir(f) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
}

export function loadPortfolio(account) {
  const f = portfolioFile(account);
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { initialCapital: 0, cash: 0, repos: [], repoPnlC: 0, positions: {}, history: [], nextId: 1, updatedAt: null };
  }
}

function savePortfolio(p, account) {
  const f = portfolioFile(account);
  ensureDir(f);
  if (fs.existsSync(f)) {
    fs.copyFileSync(f, f + '.bak'); // 最近一份备份
    // 每日独立快照（backup/portfolio-YYYYMMDD.json），保留最近 30 份
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const snapDir = path.join(path.dirname(f), 'backup');
    fs.mkdirSync(snapDir, { recursive: true });
    const snap = path.join(snapDir, path.basename(f).replace(/\.json$/, `-${day}.json`));
    if (!fs.existsSync(snap)) fs.copyFileSync(f, snap);
    // 清理：backup 里只保留最近 30 份
    const snaps = fs.readdirSync(snapDir).filter((x) => x.endsWith('.json')).sort().reverse();
    for (const old of snaps.slice(30)) fs.rmSync(path.join(snapDir, old), { force: true });
  }
  const maxId = p.history.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
  let auto = maxId + 1;
  for (const h of p.history) if (typeof h.id !== 'number') h.id = auto++;
  ensureNextId(p);
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
  return f;
}

function ensureNextId(p) {
  const maxId = p.history.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
  if (typeof p.nextId !== 'number' || p.nextId <= maxId) p.nextId = maxId + 1;
  return p.nextId;
}

/** 裸代码 → 带交易所后缀（行情接口要求）。覆盖股票、ETF/LOF、国债逆回购。
 *  沪市：6xx 股票、5xx ETF/基金、9xx B股、204xxx 逆回购
 *  深市：0xx/3xx 股票、1xx ETF/LOF/债、1318xx 逆回购 */
export function toThscode(code) {
  const c = String(code).replace(/[^0-9]/g, '');
  if (/^204/.test(c)) return c + '.SH';        // 沪市逆回购（GC001 等）
  if (/^1318/.test(c)) return c + '.SZ';       // 深市逆回购
  if (/^[569]/.test(c)) return c + '.SH';      // 沪市：股票/ETF/基金/B股
  if (/^[0123]/.test(c)) return c + '.SZ';     // 深市：股票/ETF/LOF/B股
  return c;
}

/** 标的类型：repo=逆回购、etf=ETF/LOF、stock=股票（用于展示/统计） */
export function assetTypeOf(code) {
  const c = String(code).replace(/[^0-9]/g, '');
  if (/^204/.test(c) || /^1318/.test(c)) return 'repo';
  if (/^[15]/.test(c)) return 'etf';
  return 'stock';
}

/** 建仓 / 加仓（fee/price 按"元"传入，内部转分）
 *  stop/target/zoneLow/zoneHigh = 计划参数（元，可选）：止损价 / 第一目标价 / 计划买入区，供持仓分析判定 */
export function addPosition({ code, name = '', shares, price, date, time = '', note = '', psych = '', fee = 0, stop, target, zoneLow, zoneHigh, account }) {
  const p = loadPortfolio(account);
  const sh = Math.floor(Number(shares));
  if (!Number.isFinite(sh) || sh <= 0) throw new Error('股数必须为正数');
  const priceC = toCents(price);
  if (priceC <= 0) throw new Error('价格必须为正数');
  const feeC = toCents(fee);
  const amountC = priceC * sh;
  const costC = amountC + feeC;
  const key = String(code);
  ensureNextId(p);
  const existing = p.positions[key];
  if (existing) {
    const newShares = existing.shares + sh;
    const newCostC = Number(existing.cost) + costC;
    existing.shares = newShares;
    existing.avgCost = Math.round(newCostC / newShares);
    existing.cost = newCostC;
    existing.openDate = existing.openDate || date || new Date().toISOString().slice(0, 10);
    if (!existing.name && name) existing.name = name;
    if (note) existing.note = (existing.note ? existing.note + '；' : '') + note;
    applyPlan(existing, { stop, target, zoneLow, zoneHigh });
  } else {
    p.positions[key] = {
      code: key, name: name || key, shares: sh,
      avgCost: Math.round(costC / sh), cost: costC,
      openDate: date || new Date().toISOString().slice(0, 10), note,
    };
    applyPlan(p.positions[key], { stop, target, zoneLow, zoneHigh });
  }
  p.history.push({ id: p.nextId++, type: 'buy', code: key, name: name || key, shares: sh, price: priceC, amount: amountC, fee: feeC, date: date || new Date().toISOString().slice(0, 10), time, note, psych, realizedPnl: null });
  savePortfolio(p, account);
  return p.positions[key];
}

/** 计划参数写入持仓（**厘**存储，ETF 三位小数不丢精度；未传的字段不改动） */
function applyPlan(pos, { stop, target, zoneLow, zoneHigh }) {
  const set = (field, v) => {
    if (v === undefined || v === null || v === '') return;
    const m = toMilli(v);
    if (m > 0) pos[field] = m;
  };
  set('stopMilli', stop);
  set('targetMilli', target);
  set('zoneLowMilli', zoneLow);
  set('zoneHighMilli', zoneHigh);
  return pos;
}

/** 给已有持仓补/改计划参数（止损/目标/买入区）；传 0 表示清除该字段 */
export function setPlan({ code, stop, target, zoneLow, zoneHigh, account }) {
  const p = loadPortfolio(account);
  const key = String(code);
  const pos = p.positions[key];
  if (!pos) throw new Error(`未持有 ${key}，无法设置计划参数（先 position add）`);
  const clr = (field, v) => {
    if (v === undefined || v === null || v === '') return;
    const m = toMilli(v);
    if (m <= 0) delete pos[field];
    else pos[field] = m;
  };
  clr('stopMilli', stop);
  clr('targetMilli', target);
  clr('zoneLowMilli', zoneLow);
  clr('zoneHighMilli', zoneHigh);
  savePortfolio(p, account);
  return pos;
}

/** 减仓 / 清仓 */
export function sellPosition({ code, shares, price, date, time = '', note = '', psych = '', fee = 0, account }) {
  const p = loadPortfolio(account);
  const key = String(code);
  const pos = p.positions[key];
  if (!pos) throw new Error(`未持有 ${key}，无法卖出`);
  const sh = Math.floor(Number(shares));
  if (!Number.isFinite(sh) || sh <= 0) throw new Error('股数必须为正数');
  if (sh > pos.shares) throw new Error(`卖出 ${sh} 股超过持仓 ${pos.shares} 股`);
  const priceC = toCents(price);
  const feeC = toCents(fee);
  const realizedC = Math.round((priceC - Number(pos.avgCost)) * sh) - feeC;
  p.history.push({ id: p.nextId++, type: 'sell', code: key, name: pos.name, shares: sh, price: priceC, amount: priceC * sh, fee: feeC, date: date || new Date().toISOString().slice(0, 10), time, note, psych, realizedPnl: realizedC });
  pos.shares -= sh;
  pos.cost = Number(pos.cost) - Math.round(Number(pos.avgCost) * sh);
  if (pos.shares <= 0) delete p.positions[key];
  savePortfolio(p, account);
  return { code: key, shares: pos.shares ?? 0, realizedPnl: realizedC, closed: !(p.positions[key]) };
}

/** 设初始本金（元→分） */
export function setCapital(capital, account) {
  const p = loadPortfolio(account);
  p.initialCapital = toCents(capital);
  savePortfolio(p, account);
  return p.initialCapital;
}

/** 记录现金余额（元→分） */
export function setCash(amount, account) {
  const p = loadPortfolio(account);
  p.cash = toCents(amount);
  savePortfolio(p, account);
  return p.cash;
}

// ── 国债逆回购（GC001/204001 等：融出资金、到期收回本息）────────────────────

/** 记一笔逆回购：amount 元、rate 年化%（如 1.01）、days 天数 */
export function addRepo({ code = '204001', amount, rate, days = 1, date, note = '', account }) {
  const p = loadPortfolio(account);
  p.repos = p.repos || [];
  const amountC = toCents(amount);
  if (amountC <= 0) throw new Error('逆回购金额必须为正');
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) throw new Error('逆回购利率(%)必须为正，如 1.01');
  const d = Math.max(1, Math.floor(Number(days) || 1));
  const start = date || new Date().toISOString().slice(0, 10);
  const due = new Date(new Date(start + 'T00:00:00+08:00').getTime() + d * 86400000).toISOString().slice(0, 10);
  const interestC = Math.round(amountC * (r / 100) * (d / 365)); // 预期收益（分）
  const id = (p.repos.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0)) + 1;
  const rec = { id, code: String(code), amountC, rate: r, days: d, date: start, dueDate: due, settled: false, interestC, note };
  p.repos.push(rec);
  savePortfolio(p, account);
  return rec;
}

/** 结算逆回购：本金+收益回笼到现金，收益计入逆回购累计收益 */
export function settleRepo({ id, account }) {
  const p = loadPortfolio(account);
  p.repos = p.repos || [];
  const rec = p.repos.find((x) => Number(x.id) === Number(id));
  if (!rec) throw new Error(`未找到逆回购 #${id}`);
  if (rec.settled) throw new Error(`逆回购 #${id} 已结算`);
  rec.settled = true;
  rec.settledAt = new Date().toISOString().slice(0, 10);
  p.cash = (Number(p.cash) || 0) + rec.amountC + rec.interestC;
  p.repoPnlC = (Number(p.repoPnlC) || 0) + rec.interestC;
  savePortfolio(p, account);
  return rec;
}

/** 逆回购列表（默认仅未结算；all=true 全部） */
export function listRepos(account, { all = false } = {}) {
  const p = loadPortfolio(account);
  return (p.repos || []).filter((x) => all || !x.settled);
}

/** 清空台账（account 可选） */
export function resetPortfolio(account) {
  const f = portfolioFile(account);
  ensureDir(f);
  fs.writeFileSync(f, JSON.stringify({ initialCapital: 0, cash: 0, repos: [], repoPnlC: 0, positions: {}, history: [], nextId: 1, updatedAt: null }, null, 2));
  return f;
}

/** 估算手续费（返回分） */
export function estimateFee({ side, shares, price, account }) {
  const prof = getFeeProfile(account);
  const sh = Math.floor(Number(shares));
  const amountC = toCents(price) * sh;
  const commissionC = Math.max(Math.round(amountC * prof.commissionRate), toCents(prof.commissionMin || 0));
  const transferC = Math.round(amountC * (prof.transferFeeRate || 0));
  const stampC = side === 'sell' ? Math.round(amountC * (prof.stampTaxRate || 0)) : 0;
  return commissionC + transferC + stampC;
}

/** 除息/复权成本调整：按 adjustment-factors 中"持仓起始日后"的每股分红下调成本（分，避免浮点） */
export async function adjustForDividends(code, account) {
  const p = loadPortfolio(account);
  const pos = p.positions[String(code)];
  if (!pos) throw new Error(`未持有 ${code}，无法调整除息`);
  const r = await getData('adjustment-factors', { thscode: toThscode(code) });
  if (r && r.code !== undefined && r.code !== 0) throw new Error(`复权数据获取失败: code=${r.code} ${r.message}`);
  const items = r?.data?.item ?? [];
  const openMs = pos.openDate ? new Date(String(pos.openDate) + 'T00:00:00+08:00').getTime() : 0;
  let divC = 0; // 持有期内累计分红（分/股）
  for (const it of items) {
    const exMs = Number(it.ex_date_ms);
    if (Number.isFinite(exMs) && exMs < openMs) continue; // 持仓起始日前的分红不调（券商成本已含）
    divC += Math.round(toCents(it.dividend_per_share)); // 每事件，元→分
  }
  if (divC <= 0) return { adjusted: false, totalDivC: 0, reason: '持有期内无分红/复权事件（成本无需调整）' };
  const avgBefore = Number(pos.avgCost);
  pos.avgCost = Math.max(0, avgBefore - divC);
  pos.cost = Math.max(0, Number(pos.cost) - divC * pos.shares);
  savePortfolio(p, account);
  return { adjusted: true, totalDivC: divC, avgBefore, avgAfter: pos.avgCost };
}

/** 拉取持仓现价（**厘**，0.001 元；ETF 报价最小变动 0.001，用分记价会失真）。
 *  返回 { pricesMilli, missing } —— missing=未取到行情的代码，
 *  调用方必须把「按成本价兜底」这件事告诉用户，不能让 0 浮盈冒充真实盈亏。 */
async function fetchPrices(codes) {
  const pricesMilli = {};
  const missing = [];
  if (!codes.length) return { pricesMilli, missing };
  // 同时登记裸代码与带后缀代码，避免台账代码格式与接口回包不一致导致取不到价
  const put = (code, it, milli) => {
    if (!milli) return;
    for (const k of [code, it?.ticker, it?.thscode]) if (k) pricesMilli[String(k)] = milli;
  };
  // 股票/指数走 A股快照（批量）
  const stocks = codes.filter((c) => assetTypeOf(c) !== 'etf');
  if (stocks.length) {
    try {
      const res = await getData('price-snapshot', { thscodes: stocks.map(toThscode).join(',') });
      for (const it of res?.data?.item ?? []) {
        const hit = stocks.find((c) => String(c) === String(it.ticker) || String(c) === String(it.thscode));
        put(hit ?? it.ticker, it, toMilli(it.last_price));
      }
    } catch { /* 忽略，缺失的用成本价并计入 missing */ }
  }
  // ETF 走场内基金快照（单只；偶发 code=3002 数据未就绪）
  for (const e of codes.filter((c) => assetTypeOf(c) === 'etf')) {
    let milli = 0;
    let it = null;
    try {
      const res = await getData('fund-market-snapshot', { thscode: toThscode(e) });
      it = res?.data?.item?.[0] ?? null;
      if (it) milli = toMilli(it.last_price);
    } catch { /* 忽略 */ }
    if (!milli) {
      // 快照未就绪 → 退回最近一根前复权日线收盘（比直接按成本价报 0 浮盈更诚实）
      try {
        const end = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const start = new Date(Date.now() - 10 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const res = await getData('fund-market-historical', { thscode: toThscode(e), interval: '1d', start, end });
        const items = res?.data?.item ?? [];
        if (items.length) milli = toMilli(items[items.length - 1].close_price);
      } catch { /* 忽略 */ }
    }
    put(e, it, milli);
  }
  for (const c of codes) if (!pricesMilli[c]) missing.push(c);
  return { pricesMilli, missing };
}

/** 持仓列表（分字段；priceMilli=厘，price=分，市值/浮盈按厘×股数精确到分） */
export async function listPositions(account) {
  const p = loadPortfolio(account);
  const codes = Object.keys(p.positions);
  const { pricesMilli, missing } = await fetchPrices(codes);
  const rows = codes.map((c) => {
    const pos = p.positions[c];
    const avgMilli = Number(pos.avgCost) * 10;
    const priceMilli = pricesMilli[c] || avgMilli;
    const marketValueC = milliTimesSharesToCents(priceMilli, pos.shares);
    const pnlC = milliTimesSharesToCents(priceMilli - avgMilli, pos.shares);
    return {
      ...pos, priceMilli, price: Math.round(priceMilli / 10), marketValue: marketValueC, pnl: pnlC,
      quoteMissing: !pricesMilli[c],
      pnlPct: avgMilli ? Math.round(((priceMilli - avgMilli) / avgMilli) * 10000) / 100 : 0,
    };
  });
  return { initialCapital: p.initialCapital, cash: p.cash, rows, missing, file: portfolioFile(account) };
}

/** 总览（分字段；cash 现金；marketValueC 证券市值；totalAssetsC=市值+现金+未结算逆回购本金） */
export async function summary(account) {
  const p = loadPortfolio(account);
  const codes = Object.keys(p.positions);
  const { pricesMilli, missing } = await fetchPrices(codes);
  let totalCostC = 0, marketValueC = 0, pnlC = 0;
  for (const c of codes) {
    const pos = p.positions[c];
    const avgMilli = Number(pos.avgCost) * 10;
    const priceMilli = pricesMilli[c] || avgMilli;
    totalCostC += Number(pos.cost);
    marketValueC += milliTimesSharesToCents(priceMilli, pos.shares);
    pnlC += milliTimesSharesToCents(priceMilli - avgMilli, pos.shares);
  }
  const realizedC = Math.round(p.history.filter((h) => h.type === 'sell').reduce((s, h) => s + (Number(h.realizedPnl) || 0), 0));
  const repos = p.repos || [];
  const openRepos = repos.filter((x) => !x.settled);
  const repoPrincipalC = openRepos.reduce((s, x) => s + Number(x.amountC), 0);
  const repoInterestC = openRepos.reduce((s, x) => s + Number(x.interestC), 0);
  return {
    initialCapital: p.initialCapital, cash: Number(p.cash) || 0,
    positionCount: codes.length, totalCostC, marketValueC,
    floatPnl: pnlC, realizedPnl: realizedC, totalPnl: pnlC + realizedC,
    repoPrincipalC, repoInterestC, repoCount: openRepos.length, repoPnlC: Number(p.repoPnlC) || 0,
    totalAssetsC: marketValueC + (Number(p.cash) || 0) + repoPrincipalC,
    missing, file: portfolioFile(account),
  };
}

// ── 持仓股分析（计划参数 vs 当日真实行情）──────────────────────────────────
// 判定引擎照《复盘模板生成指南》§3：当日最低价 ≤ 买入区上沿 且 收盘 ≥ 止损 → 可低吸；
// 触/逼第一目标 → 持有止盈；跌破买区下沿/逼近止损 → 观望规避；不换股、不改计划参数。

/** 毫秒戳 → Asia/Shanghai 日期（YYYY-MM-DD） */
function shDate(ms) {
  return new Date(Number(ms)).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

/** 完整行情快照（含开/高/低/现价/昨收/涨跌幅），按裸代码+ticker+thscode 三重登记。
 *  注意：快照时间戳在响应信封 data.timestamp 上，不在 item 里——必须并进去，否则判断不出"是否当日实时价" */
async function fetchQuotes(codes) {
  const map = {};
  const put = (key, it, ts) => {
    if (!it) return;
    const rec = ts ? { ...it, timestamp: it.timestamp ?? ts } : it;
    for (const k of [key, it.ticker, it.thscode]) if (k) map[String(k)] = rec;
  };
  const stocks = codes.filter((c) => assetTypeOf(c) === 'stock');
  if (stocks.length) {
    try {
      const res = await getData('price-snapshot', { thscodes: stocks.map(toThscode).join(',') });
      const ts = res?.data?.timestamp;
      for (const it of res?.data?.item ?? []) {
        const hit = stocks.find((c) => String(c) === String(it.ticker) || String(c) === String(it.thscode)) ?? it.ticker;
        put(hit, it, ts);
      }
    } catch { /* 缺失走日线兜底 */ }
  }
  for (const e of codes.filter((c) => assetTypeOf(c) === 'etf')) {
    try {
      const res = await getData('fund-market-snapshot', { thscode: toThscode(e) });
      put(e, res?.data?.item?.[0] ?? null, res?.data?.timestamp);
    } catch { /* 缺失走日线兜底 */ }
  }
  return map;
}

/** 取某日（含）前的日线：target=当日或最近一根，prev=前一根（算涨跌幅）。
 *  股票用未复权价（止损/目标是盘面实际价，前复权会与计划价错位）；ETF 走 fund-market-historical。 */
async function fetchBars(code, date) {
  const isEtf = assetTypeOf(code) === 'etf';
  const from = new Date(Date.parse(date + 'T00:00:00+08:00') - 25 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const params = { thscode: toThscode(code), interval: '1d', start: from, end: date };
  if (!isEtf) params.adjust = 'none';
  const res = await getData(isEtf ? 'fund-market-historical' : 'price-historical', params);
  if (res && res.code !== undefined && res.code !== 0) throw new Error(`code=${res.code} ${res.message}`);
  const items = (res?.data?.item ?? []).slice().sort((a, b) => a.date_ms - b.date_ms);
  const upto = items.filter((b) => shDate(b.date_ms) <= date);
  return { target: upto[upto.length - 1] ?? null, prev: upto[upto.length - 2] ?? null };
}

/** 计划参数 vs 当日行情 → 分组/徽标/操作取向（对照指南 §3；无计划参数则只做成本盈亏分析）。
 *  入参与计划价统一用「厘」，避免 ETF 三位小数与分位精度打架。 */
function classifyPlan({ lowM, highM, closeM }, plan) {
  const stopM = Number(plan.stopMilli) || 0;
  const targetM = Number(plan.targetMilli) || 0;
  const zoneHighM = Number(plan.zoneHighMilli) || 0;
  const disp = (m) => `¥${formatMilli(m, m % 10 === 0 ? 2 : 3)}`;
  const hasPlan = Boolean(stopM || targetM || plan.zoneLowMilli || zoneHighM);
  if (stopM && lowM && lowM <= stopM) {
    return { group: 'stop', badge: '⚠️ 盘中破止损', action: `盘中已触及止损 ${disp(stopM)}，按纪律离场，破止损不摊平`, level: 0 };
  }
  if (stopM && closeM <= Math.round(stopM * 1.02)) {
    return { group: 'stop', badge: '⚠️ 逼近止损', action: `收盘距止损 ${disp(stopM)} 不足 2%，紧盯盘面，破位即走`, level: 1 };
  }
  if (targetM && highM && highM >= targetM) {
    return { group: 'target', badge: '🎯 触第一目标', action: `盘中已触及目标 ${disp(targetM)}，分批止盈，不追高`, level: 2 };
  }
  if (targetM && closeM >= Math.round(targetM * 0.98)) {
    return { group: 'target', badge: '🎯 逼近目标', action: `收盘距目标 ${disp(targetM)} 不足 2%，可减半仓锁定利润`, level: 3 };
  }
  if (zoneHighM && lowM && lowM <= zoneHighM && (!stopM || closeM >= stopM)) {
    return { group: 'zone', badge: '✅ 回到买入区', action: `当日最低回到买入区上沿 ${disp(zoneHighM)} 以内，计划内可低吸/加仓，不追阳线`, level: 4 };
  }
  return {
    group: 'hold',
    badge: hasPlan ? '➖ 持有观察' : '➖ 持有观察（未设计划参数）',
    action: hasPlan ? '未触及计划区间，持仓观察，不追阳线' : '台账未记止损/目标/买入区，仅做成本盈亏分析（position plan 可补）',
    level: 5,
  };
}

/**
 * 持仓股分析：逐只拉行情（快照 + 当日日线）与计划参数比对，输出分组/触发/操作取向。
 * - date 默认今天（Asia/Shanghai）；非交易日自动回退到最近一根日线
 * - 计划参数（stopC/targetC/zoneLowC/zoneHighC）缺失时只做成本盈亏分析
 */
export async function analyzeHoldings({ date, account } = {}) {
  const p = loadPortfolio(account);
  const day = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const codes = Object.keys(p.positions);
  const [quotes, barsList] = await Promise.all([
    fetchQuotes(codes),
    Promise.all(codes.map(async (c) => {
      try { return [c, await fetchBars(c, day)]; } catch (e) { return [c, { error: e.message }]; }
    })),
  ]);
  const bars = Object.fromEntries(barsList);
  const rows = [];
  const pct = (a, b2) => (b2 ? Math.round(((a - b2) / b2) * 10000) / 100 : null);
  for (const c of codes) {
    const pos = p.positions[c];
    const q = quotes[c] || null;
    const b = bars[c] || {};
    const bar = b.target || null;
    // 快照仅在其日期 == 分析日时可用（否则是隔日数据，避免把旧价当当日）
    const snapFresh = q && q.timestamp && shDate(q.timestamp) === day;
    const pick = (k) => (snapFresh ? toMilli(q[k]) : bar ? toMilli(bar[k]) : 0);
    const priceMilli = pick('last_price') || (bar ? toMilli(bar.close_price) : 0);
    const openMilli = pick('open_price');
    const highMilli = pick('high_price');
    const lowMilli = pick('low_price');
    const prevMilli = snapFresh ? toMilli(q.prev_price) : b.prev ? toMilli(b.prev.close_price) : 0;
    const plan = { stopMilli: pos.stopMilli, targetMilli: pos.targetMilli, zoneLowMilli: pos.zoneLowMilli, zoneHighMilli: pos.zoneHighMilli };
    const cls = classifyPlan({ lowM: lowMilli, highM: highMilli, closeM: priceMilli }, plan);
    const avgMilli = Number(pos.avgCost) * 10;
    const marketValueC = milliTimesSharesToCents(priceMilli, pos.shares);
    const floatPnlC = milliTimesSharesToCents(priceMilli - avgMilli, pos.shares);
    // 涨跌幅优先用数据源原值（厘级价差不足以还原真实涨跌幅）
    const srcRatio = snapFresh ? Number(q.price_change_ratio_pct) : NaN;
    rows.push({
      code: c, name: pos.name || c, isEtf: assetTypeOf(c) === 'etf', shares: pos.shares,
      avgCost: Number(pos.avgCost), avgMilli, price: Math.round(priceMilli / 10), priceMilli,
      open: Math.round(openMilli / 10), high: Math.round(highMilli / 10), low: Math.round(lowMilli / 10),
      openMilli, highMilli, lowMilli, prev: Math.round(prevMilli / 10), prevMilli,
      changePct: Number.isFinite(srcRatio) ? Math.round(srcRatio * 100) / 100 : pct(priceMilli, prevMilli),
      marketValue: marketValueC, floatPnl: floatPnlC, floatPnlPct: pct(priceMilli, avgMilli),
      cost: Number(pos.cost), openDate: pos.openDate, plan,
      stop: plan.stopMilli || null, target: plan.targetMilli || null, zoneLow: plan.zoneLowMilli || null, zoneHigh: plan.zoneHighMilli || null,
      distStopPct: plan.stopMilli ? pct(priceMilli, plan.stopMilli) : null,
      distTargetPct: plan.targetMilli ? pct(priceMilli, plan.targetMilli) : null,
      group: cls.group, badge: cls.badge, action: cls.action, level: cls.level,
      hasPlan: Boolean(plan.stopMilli || plan.targetMilli || plan.zoneLowMilli || plan.zoneHighMilli),
      quoteMissing: !priceMilli,
      barsError: b.error || null,
      dataSource: snapFresh ? '实时快照' : bar ? `日线(${shDate(bar.date_ms)})` : '无数据',
      psych: pos.psych || '', note: pos.note || '',
    });
  }
  const valid = rows.filter((r) => !r.quoteMissing);
  const sum = (f) => rows.reduce((s, r) => s + (f(r) || 0), 0);
  const marketValueC = sum((r) => r.marketValue);
  const floatPnlC = sum((r) => r.floatPnl);
  const costC = sum((r) => r.cost);
  const groups = ['stop', 'target', 'zone', 'hold'].map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) })).filter((g) => g.rows.length);
  return {
    date: day, account: account || null, rows, groups,
    summary: {
      count: rows.length, validCount: valid.length,
      costC, marketValueC, floatPnlC,
      floatPnlPct: costC ? Math.round((floatPnlC / costC) * 10000) / 100 : null,
      cash: Number(p.cash) || 0, initialCapital: p.initialCapital,
      planMissing: rows.filter((r) => !r.hasPlan).length,
      missingQuote: rows.filter((r) => r.quoteMissing).map((r) => r.code),
      groupCounts: Object.fromEntries(groups.map((g) => [g.group, g.rows.length])),
    },
  };
}

/** 当日交易流水 */
export function dayTrades(date, account) {
  const p = loadPortfolio(account);
  const d = date || new Date().toISOString().slice(0, 10);
  return p.history.filter((h) => h.date === d);
}

/** 给一笔已有交易追加/更新心理备注 */
export function addPsychNote({ code, date, text, account }) {
  const p = loadPortfolio(account);
  const key = String(code);
  const matches = p.history.filter((h) => h.code === key && (!date || h.date === date));
  if (!matches.length) throw new Error(`未找到 ${key}${date ? ' 在 ' + date : ''} 的交易，无法加心理备注`);
  const target = matches[matches.length - 1];
  target.psych = text;
  savePortfolio(p, account);
  return { id: target.id, code: target.code, shares: target.shares, date: target.date, psych: target.psych };
}

/** 批量导入交易（反向录入）：按 date 升序执行 buy/sell；netInvestC=净投入（分） */
export function importTrades(trades, account) {
  const sorted = [...trades].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '').localeCompare(String(b.time || '')));
  let netInvestC = 0, count = 0;
  for (const t of sorted) {
    const type = (t.type || 'buy').toLowerCase();
    if (type === 'buy') {
      addPosition({ code: t.code, name: t.name, shares: t.shares, price: t.price, fee: t.fee, date: t.date, time: t.time, note: t.note, psych: t.psych, account });
      netInvestC += (toCents(t.price) * t.shares) + toCents(t.fee);
    } else if (type === 'sell') {
      sellPosition({ code: t.code, shares: t.shares, price: t.price, fee: t.fee, date: t.date, time: t.time, note: t.note, psych: t.psych, account });
      netInvestC -= (toCents(t.price) * t.shares) - toCents(t.fee);
    }
    count++;
  }
  return { count, netInvestC, file: portfolioFile(account) };
}