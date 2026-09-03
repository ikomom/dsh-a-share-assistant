// 交易台账：记录本金、建仓、加仓、减仓/清仓，供复盘与持仓盈亏计算。
// 数据存 {cwd}/.a-share-assistant/portfolio.json（用户可见，含敏感财务，建议 gitignore）。
// 精度：所有金额/价格/手续费/盈亏内部一律用"分"（整数）运算，展示时用 formatYuan 转两位元 → 无 JS 浮点误差。
import fs from 'node:fs';
import path from 'node:path';
import { getData } from './fuyao.js';
import { homeDir, getFeeProfile } from './config.js';
import { toCents, formatYuan } from './money.js';

const FILE_NAME = 'portfolio.json';

export function portfolioFile() {
  return path.join(homeDir(), FILE_NAME);
}

function ensureDir(f) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
}

export function loadPortfolio() {
  const f = portfolioFile();
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { initialCapital: 0, positions: {}, history: [], nextId: 1, updatedAt: null };
  }
}

function savePortfolio(p) {
  const f = portfolioFile();
  ensureDir(f);
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

/** 建仓 / 加仓（fee/price 按"元"传入，内部转分；psych 为心理备注） */
export function addPosition({ code, name = '', shares, price, date, note = '', psych = '', fee = 0 }) {
  const p = loadPortfolio();
  const sh = Math.floor(Number(shares));
  if (!Number.isFinite(sh) || sh <= 0) throw new Error('股数必须为正数');
  const priceC = toCents(price);
  if (priceC <= 0) throw new Error('价格必须为正数');
  const feeC = toCents(fee);
  const amountC = priceC * sh;      // 成交额（分）
  const costC = amountC + feeC;     // 含手续费成本（分）
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
  p.history.push({ id: p.nextId++, type: 'buy', code: key, name: name || key, shares: sh, price: priceC, amount: amountC, fee: feeC, date: date || new Date().toISOString().slice(0, 10), note, psych, realizedPnl: null });
  savePortfolio(p);
  return p.positions[key];
}

/** 减仓 / 清仓（fee/price 按"元"传入；realizedPnl 为分） */
export function sellPosition({ code, shares, price, date, note = '', psych = '', fee = 0 }) {
  const p = loadPortfolio();
  const key = String(code);
  const pos = p.positions[key];
  if (!pos) throw new Error(`未持有 ${key}，无法卖出`);
  const sh = Math.floor(Number(shares));
  if (!Number.isFinite(sh) || sh <= 0) throw new Error('股数必须为正数');
  if (sh > pos.shares) throw new Error(`卖出 ${sh} 股超过持仓 ${pos.shares} 股`);
  const priceC = toCents(price);
  const feeC = toCents(fee);
  const realizedC = Math.round((priceC - Number(pos.avgCost)) * sh) - feeC;
  p.history.push({ id: p.nextId++, type: 'sell', code: key, name: pos.name, shares: sh, price: priceC, amount: priceC * sh, fee: feeC, date: date || new Date().toISOString().slice(0, 10), note, psych, realizedPnl: realizedC });
  pos.shares -= sh;
  pos.cost = Number(pos.cost) - Math.round(Number(pos.avgCost) * sh);
  if (pos.shares <= 0) delete p.positions[key];
  savePortfolio(p);
  return { code: key, shares: pos.shares ?? 0, realizedPnl: realizedC, closed: !(p.positions[key]) };
}

/** 设初始本金（按元传入，存分） */
export function setCapital(capital) {
  const p = loadPortfolio();
  p.initialCapital = toCents(capital);
  savePortfolio(p);
  return p.initialCapital;
}

/** 清空台账（重建前用）：本金/持仓/历史全清。 */
export function resetPortfolio() {
  const f = portfolioFile();
  ensureDir(f);
  fs.writeFileSync(f, JSON.stringify({ initialCapital: 0, positions: {}, history: [], nextId: 1, updatedAt: null }, null, 2));
  return f;
}

/** 按费率估算一笔交易的手续费（返回分；side=buy|sell；account 选 feeProfiles 账户） */
export function estimateFee({ side, shares, price, account }) {
  const prof = getFeeProfile(account);
  const sh = Math.floor(Number(shares));
  const amountC = toCents(price) * sh;
  const commissionC = Math.max(Math.round(amountC * prof.commissionRate), toCents(prof.commissionMin || 0));
  const transferC = Math.round(amountC * (prof.transferFeeRate || 0));
  const stampC = side === 'sell' ? Math.round(amountC * (prof.stampTaxRate || 0)) : 0;
  return commissionC + transferC + stampC;
}

/** 裸代码 → 带交易所后缀（行情接口要求），如 600900→600900.SH、000983→000983.SZ */
function toThscode(code) {
  const c = String(code).replace(/[^0-9]/g, '');
  if (/^(60|68)/.test(c)) return c + '.SH';
  if (/^(00|30)/.test(c)) return c + '.SZ';
  return c;
}

async function fetchPrices(codes) {
  if (!codes.length) return {};
  try {
    const res = await getData('price-snapshot', { thscodes: codes.map(toThscode).join(',') });
    const item = res?.data?.item ?? [];
    const map = {};
    for (const it of item) map[String(it.ticker || it.thscode)] = toCents(Number(it.last_price) || 0);
    return map;
  } catch {
    return {};
  }
}

/** 持仓列表（返回分字段；price/市值/盈亏均为分） */
export async function listPositions() {
  const p = loadPortfolio();
  const codes = Object.keys(p.positions);
  const pricesC = await fetchPrices(codes);
  const rows = codes.map((c) => {
    const pos = p.positions[c];
    const priceC = pricesC[c] || Number(pos.avgCost);
    const marketValueC = priceC * pos.shares;
    const pnlC = Math.round((priceC - Number(pos.avgCost)) * pos.shares);
    return { ...pos, price: priceC, marketValue: marketValueC, pnl: pnlC, pnlPct: Number(pos.avgCost) ? Math.round((priceC / Number(pos.avgCost) - 1) * 10000) / 100 : 0 };
  });
  return { initialCapital: p.initialCapital, rows, file: portfolioFile() };
}

/** 总览（分字段） */
export async function summary() {
  const p = loadPortfolio();
  const codes = Object.keys(p.positions);
  const pricesC = await fetchPrices(codes);
  let totalCostC = 0, marketValueC = 0, pnlC = 0;
  for (const c of codes) {
    const pos = p.positions[c];
    const priceC = pricesC[c] || Number(pos.avgCost);
    totalCostC += Number(pos.cost);
    marketValueC += priceC * pos.shares;
    pnlC += Math.round((priceC - Number(pos.avgCost)) * pos.shares);
  }
  const realizedC = Math.round(p.history.filter((h) => h.type === 'sell').reduce((s, h) => s + (Number(h.realizedPnl) || 0), 0));
  return {
    initialCapital: p.initialCapital,
    positionCount: codes.length,
    totalCostC, marketValueC, floatPnl: pnlC, realizedPnl: realizedC,
    totalPnl: pnlC + realizedC, file: portfolioFile(),
  };
}

/** 当日交易流水 */
export function dayTrades(date) {
  const p = loadPortfolio();
  const d = date || new Date().toISOString().slice(0, 10);
  return p.history.filter((h) => h.date === d);
}

/** 给一笔已有交易追加/更新心理备注 */
export function addPsychNote({ code, date, text }) {
  const p = loadPortfolio();
  const key = String(code);
  const matches = p.history.filter((h) => h.code === key && (!date || h.date === date));
  if (!matches.length) throw new Error(`未找到 ${key}${date ? ' 在 ' + date : ''} 的交易，无法加心理备注`);
  const target = matches[matches.length - 1];
  target.psych = text;
  savePortfolio(p);
  return { id: target.id, code: target.code, shares: target.shares, date: target.date, psych: target.psych };
}

/**
 * 批量导入交易（反向录入）：按 date 升序依次执行 buy/sell，据此建立台账。
 * 返回 netInvestC（净投入，分）= Σ(买入额+买费) − Σ(卖出额−卖费)，可作为初始本金。
 * trades 每笔: { type:'buy'|'sell', code, name?, shares, price, fee?, date?, note?, psych? }
 */
export function importTrades(trades) {
  const sorted = [...trades].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let netInvestC = 0, count = 0;
  for (const t of sorted) {
    const type = (t.type || 'buy').toLowerCase();
    if (type === 'buy') {
      addPosition({ code: t.code, name: t.name, shares: t.shares, price: t.price, fee: t.fee, date: t.date, note: t.note, psych: t.psych });
      netInvestC += (toCents(t.price) * t.shares) + toCents(t.fee);
    } else if (type === 'sell') {
      sellPosition({ code: t.code, shares: t.shares, price: t.price, fee: t.fee, date: t.date, note: t.note, psych: t.psych });
      netInvestC -= (toCents(t.price) * t.shares) - toCents(t.fee);
    }
    count++;
  }
  return { count, netInvestC, file: portfolioFile() };
}