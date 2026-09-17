// 交易台账：记录本金、建仓、加仓、减仓/清仓、现金/逆回购，供复盘与持仓盈亏计算。
// 数据存 {cwd}/.a-share-assistant/portfolio[.<account>].json（敏感，git 忽略）。
// 精度：金额/价格/手续费/盈亏内部一律用"分"（整数）运算，展示 formatYuan → 无浮点误差。
// 备份：每次写入前自动复制一份 .bak（防误删/损坏）。
import fs from 'node:fs';
import path from 'node:path';
import { getData } from './fuyao.js';
import { homeDir, getFeeProfile } from './config.js';
import { toCents, formatYuan } from './money.js';

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

/** 建仓 / 加仓（fee/price 按"元"传入，内部转分） */
export function addPosition({ code, name = '', shares, price, date, time = '', note = '', psych = '', fee = 0, account }) {
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
  } else {
    p.positions[key] = {
      code: key, name: name || key, shares: sh,
      avgCost: Math.round(costC / sh), cost: costC,
      openDate: date || new Date().toISOString().slice(0, 10), note,
    };
  }
  p.history.push({ id: p.nextId++, type: 'buy', code: key, name: name || key, shares: sh, price: priceC, amount: amountC, fee: feeC, date: date || new Date().toISOString().slice(0, 10), time, note, psych, realizedPnl: null });
  savePortfolio(p, account);
  return p.positions[key];
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

/** 拉取持仓现价（分）。返回 { prices, missing } —— missing=未取到行情的代码，
 *  调用方必须把「按成本价兜底」这件事告诉用户，不能让 0 浮盈冒充真实盈亏。 */
async function fetchPrices(codes) {
  const prices = {};
  const missing = [];
  if (!codes.length) return { prices, missing };
  // 同时登记裸代码与带后缀代码，避免台账代码格式与接口回包不一致导致取不到价
  const put = (code, it, priceC) => {
    if (!priceC) return;
    for (const k of [code, it?.ticker, it?.thscode]) if (k) prices[String(k)] = priceC;
  };
  // 股票/指数走 A股快照（批量）
  const stocks = codes.filter((c) => assetTypeOf(c) !== 'etf');
  if (stocks.length) {
    try {
      const res = await getData('price-snapshot', { thscodes: stocks.map(toThscode).join(',') });
      for (const it of res?.data?.item ?? []) {
        const hit = stocks.find((c) => String(c) === String(it.ticker) || String(c) === String(it.thscode));
        put(hit ?? it.ticker, it, toCents(Number(it.last_price) || 0));
      }
    } catch { /* 忽略，缺失的用成本价并计入 missing */ }
  }
  // ETF 走场内基金快照（单只；偶发 code=3002 数据未就绪）
  for (const e of codes.filter((c) => assetTypeOf(c) === 'etf')) {
    let priceC = 0;
    let it = null;
    try {
      const res = await getData('fund-market-snapshot', { thscode: toThscode(e) });
      it = res?.data?.item?.[0] ?? null;
      if (it) priceC = toCents(Number(it.last_price) || 0);
    } catch { /* 忽略 */ }
    if (!priceC) {
      // 快照未就绪 → 退回最近一根前复权日线收盘（比直接按成本价报 0 浮盈更诚实）
      try {
        const end = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const start = new Date(Date.now() - 10 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        const res = await getData('fund-market-historical', { thscode: toThscode(e), interval: '1d', start, end });
        const items = res?.data?.item ?? [];
        if (items.length) priceC = toCents(Number(items[items.length - 1].close_price) || 0);
      } catch { /* 忽略 */ }
    }
    put(e, it, priceC);
  }
  for (const c of codes) if (!prices[c]) missing.push(c);
  return { prices, missing };
}

/** 持仓列表（分字段） */
export async function listPositions(account) {
  const p = loadPortfolio(account);
  const codes = Object.keys(p.positions);
  const { prices: pricesC, missing } = await fetchPrices(codes);
  const rows = codes.map((c) => {
    const pos = p.positions[c];
    const priceC = pricesC[c] || Number(pos.avgCost);
    const marketValueC = priceC * pos.shares;
    const pnlC = Math.round((priceC - Number(pos.avgCost)) * pos.shares);
    return { ...pos, price: priceC, marketValue: marketValueC, pnl: pnlC, quoteMissing: !pricesC[c], pnlPct: Number(pos.avgCost) ? Math.round((priceC / Number(pos.avgCost) - 1) * 10000) / 100 : 0 };
  });
  return { initialCapital: p.initialCapital, cash: p.cash, rows, missing, file: portfolioFile(account) };
}

/** 总览（分字段；cash 现金；marketValueC 股票市值；totalAssetsC=市值+现金） */
export async function summary(account) {
  const p = loadPortfolio(account);
  const codes = Object.keys(p.positions);
  const { prices: pricesC, missing } = await fetchPrices(codes);
  let totalCostC = 0, marketValueC = 0, pnlC = 0;
  for (const c of codes) {
    const pos = p.positions[c];
    const priceC = pricesC[c] || Number(pos.avgCost);
    totalCostC += Number(pos.cost);
    marketValueC += priceC * pos.shares;
    pnlC += Math.round((priceC - Number(pos.avgCost)) * pos.shares);
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