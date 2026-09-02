// 交易台账：记录本金、建仓、加仓、减仓/清仓，供复盘与持仓盈亏计算。
// 数据存 {cwd}/交易记录/portfolio.json（用户可见，含敏感财务，建议 gitignore）。
import fs from 'node:fs';
import path from 'node:path';
import { getData } from './fuyao.js';

const DATA_DIR_NAME = '交易记录';
const FILE_NAME = 'portfolio.json';

export function portfolioFile() {
  return path.join(process.cwd(), DATA_DIR_NAME, FILE_NAME);
}

function ensureDir(f) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
}

export function loadPortfolio() {
  const f = portfolioFile();
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return { initialCapital: 0, positions: {}, history: [], updatedAt: null };
  }
}

function savePortfolio(p) {
  const f = portfolioFile();
  ensureDir(f);
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
  return f;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 建仓 / 加仓 */
export function addPosition({ code, name = '', shares, price, date, note = '' }) {
  const p = loadPortfolio();
  if (!Number.isFinite(shares) || shares <= 0) throw new Error('股数必须为正数');
  if (!Number.isFinite(price) || price <= 0) throw new Error('价格必须为正数');
  const amount = shares * price;
  const key = String(code);
  const existing = p.positions[key];
  if (existing) {
    // 加仓：加权平均成本
    const newShares = existing.shares + shares;
    const newCost = existing.cost + amount;
    existing.shares = newShares;
    existing.avgCost = round2(newCost / newShares);
    existing.cost = round2(newCost);
    existing.openDate = existing.openDate || date || new Date().toISOString().slice(0, 10);
    if (!existing.name && name) existing.name = name;
    if (note) existing.note = (existing.note ? existing.note + '；' : '') + note;
  } else {
    p.positions[key] = {
      code: key, name: name || key, shares,
      avgCost: round2(price), cost: round2(amount),
      openDate: date || new Date().toISOString().slice(0, 10), note,
    };
  }
  p.history.push({ type: 'buy', code: key, name: name || key, shares, price, amount: round2(amount), date: date || new Date().toISOString().slice(0, 10), note, realizedPnl: null });
  savePortfolio(p);
  return p.positions[key];
}

/** 减仓 / 清仓 */
export function sellPosition({ code, shares, price, date, note = '' }) {
  const p = loadPortfolio();
  const key = String(code);
  const pos = p.positions[key];
  if (!pos) throw new Error(`未持有 ${key}，无法卖出`);
  if (!Number.isFinite(shares) || shares <= 0) throw new Error('股数必须为正数');
  if (shares > pos.shares) throw new Error(`卖出 ${shares} 股超过持仓 ${pos.shares} 股`);
  const realized = round2((price - pos.avgCost) * shares);
  p.history.push({ type: 'sell', code: key, name: pos.name, shares, price, amount: round2(shares * price), date: date || new Date().toISOString().slice(0, 10), note, realizedPnl: realized });
  pos.shares -= shares;
  pos.cost = round2(pos.cost - shares * pos.avgCost);
  if (pos.shares <= 0) {
    delete p.positions[key];
  }
  savePortfolio(p);
  return { code: key, shares: pos.shares ?? 0, realizedPnl: realized, closed: !(p.positions[key]) };
}

/** 设初始本金 */
export function setCapital(capital) {
  const p = loadPortfolio();
  p.initialCapital = round2(capital);
  savePortfolio(p);
  return p.initialCapital;
}

/** 拉实时价（尽力）；失败返回 null */
async function fetchPrices(codes) {
  if (!codes.length) return {};
  try {
    const res = await getData('price-snapshot', { thscodes: codes.join(',') });
    const item = res?.data?.item ?? [];
    const map = {};
    for (const it of item) {
      const k = String(it.thscode || it.ticker);
      map[k] = Number(it.last_price) || 0;
    }
    return map;
  } catch {
    return {};
  }
}

/** 持仓列表 + 盈亏（实时价优先） */
export async function listPositions() {
  const p = loadPortfolio();
  const codes = Object.keys(p.positions);
  const prices = await fetchPrices(codes);
  const rows = codes.map((c) => {
    const pos = p.positions[c];
    const price = prices[c] || pos.avgCost; // 无实时价则按成本
    const marketValue = round2(price * pos.shares);
    const pnl = round2((price - pos.avgCost) * pos.shares);
    return { ...pos, price, marketValue, pnl, pnlPct: pos.avgCost ? round2((price / pos.avgCost - 1) * 100) : 0 };
  });
  return { initialCapital: p.initialCapital, rows, file: portfolioFile() };
}

/** 总览：本金 / 持仓成本 / 市值 / 浮动盈亏 / 已实现盈亏 */
export async function summary() {
  const p = loadPortfolio();
  const codes = Object.keys(p.positions);
  const prices = await fetchPrices(codes);
  let totalCost = 0, marketValue = 0, pnl = 0;
  for (const c of codes) {
    const pos = p.positions[c];
    const price = prices[c] || pos.avgCost;
    totalCost += pos.cost;
    marketValue += round2(price * pos.shares);
    pnl += round2((price - pos.avgCost) * pos.shares);
  }
  const realized = round2(p.history.filter((h) => h.type === 'sell').reduce((s, h) => s + (h.realizedPnl || 0), 0));
  const invest = round2(totalCost);
  return {
    initialCapital: p.initialCapital,
    positionCount: codes.length,
    totalCost: round2(totalCost),
    marketValue: round2(marketValue),
    floatPnl: round2(pnl),
    realizedPnl: realized,
    totalPnl: round2(pnl + realized),
    file: portfolioFile(),
  };
}

/** 当日交易流水（供复盘"操作回顾"） */
export function dayTrades(date) {
  const p = loadPortfolio();
  const d = date || new Date().toISOString().slice(0, 10);
  return p.history.filter((h) => h.date === d);
}