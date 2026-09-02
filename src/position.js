// 交易台账：记录本金、建仓、加仓、减仓/清仓，供复盘与持仓盈亏计算。
// 数据存 {cwd}/交易记录/portfolio.json（用户可见，含敏感财务，建议 gitignore）。
import fs from 'node:fs';
import path from 'node:path';
import { getData } from './fuyao.js';
import { homeDir } from './config.js';

const FILE_NAME = 'portfolio.json';

export function portfolioFile() {
  // 台账放在系统产物目录 .a-share-assistant/portfolio.json（隐藏、git 忽略）
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
  // 迁移：给历史遗留的无 id 交易补递增 id（保证 each 笔有 id，便于 psych/复盘引用）
  const maxId = p.history.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
  let auto = maxId + 1;
  for (const h of p.history) if (typeof h.id !== 'number') h.id = auto++;
  ensureNextId(p);
  p.updatedAt = new Date().toISOString();
  fs.writeFileSync(f, JSON.stringify(p, null, 2));
  return f;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** 确保台账有递增 id：缺失/小于历史最大 id 时重置为 max+1 */
function ensureNextId(p) {
  const maxId = p.history.reduce((m, h) => Math.max(m, Number(h.id) || 0), 0);
  if (typeof p.nextId !== 'number' || p.nextId <= maxId) p.nextId = maxId + 1;
  return p.nextId;
}

/** 建仓 / 加仓（fee 为手续费，计入成本；psych 为可选心理备注） */
export function addPosition({ code, name = '', shares, price, date, note = '', psych = '', fee = 0 }) {
  const p = loadPortfolio();
  if (!Number.isFinite(shares) || shares <= 0) throw new Error('股数必须为正数');
  if (!Number.isFinite(price) || price <= 0) throw new Error('价格必须为正数');
  const f = Number.isFinite(fee) ? fee : 0;
  const amount = shares * price;
  const key = String(code);
  ensureNextId(p);
  const existing = p.positions[key];
  if (existing) {
    // 加仓：加权平均成本（含手续费）
    const newShares = existing.shares + shares;
    const newCost = existing.cost + amount + f;
    existing.shares = newShares;
    existing.avgCost = round2(newCost / newShares);
    existing.cost = round2(newCost);
    existing.openDate = existing.openDate || date || new Date().toISOString().slice(0, 10);
    if (!existing.name && name) existing.name = name;
    if (note) existing.note = (existing.note ? existing.note + '；' : '') + note;
  } else {
    p.positions[key] = {
      code: key, name: name || key, shares,
      avgCost: round2((amount + f) / shares), cost: round2(amount + f),
      openDate: date || new Date().toISOString().slice(0, 10), note,
    };
  }
  p.history.push({ id: p.nextId++, type: 'buy', code: key, name: name || key, shares, price, amount: round2(amount), fee: round2(f), date: date || new Date().toISOString().slice(0, 10), note, psych, realizedPnl: null });
  savePortfolio(p);
  return p.positions[key];
}

/** 减仓 / 清仓（fee 为卖出手续费，从已实现盈亏扣除；psych 为可选心理备注） */
export function sellPosition({ code, shares, price, date, note = '', psych = '', fee = 0 }) {
  const p = loadPortfolio();
  const key = String(code);
  const pos = p.positions[key];
  if (!pos) throw new Error(`未持有 ${key}，无法卖出`);
  ensureNextId(p);
  if (!Number.isFinite(shares) || shares <= 0) throw new Error('股数必须为正数');
  if (shares > pos.shares) throw new Error(`卖出 ${shares} 股超过持仓 ${pos.shares} 股`);
  const f = Number.isFinite(fee) ? fee : 0;
  const realized = round2((price - pos.avgCost) * shares - f);
  p.history.push({ id: p.nextId++, type: 'sell', code: key, name: pos.name, shares, price, amount: round2(shares * price), fee: round2(f), date: date || new Date().toISOString().slice(0, 10), note, psych, realizedPnl: realized });
  pos.shares -= shares;
  pos.cost = round2(pos.cost - shares * pos.avgCost);
  if (pos.shares <= 0) {
    delete p.positions[key];
  }
  savePortfolio(p);
  return { code: key, shares: pos.shares ?? 0, realizedPnl: realized, closed: !(p.positions[key]) };
}

/** 给一笔已有交易追加/更新心理备注（复盘交易心理用）。匹配 code（+date 可选），取最后一笔。 */
export function addPsychNote({ code, date, text }) {
  const p = loadPortfolio();
  const key = String(code);
  const matches = p.history.filter((h) => h.code === key && (!date || h.date === date));
  if (!matches.length) throw new Error(`未找到 ${key}${date ? ' 在 ' + date : ''} 的交易，无法加心理备注`);
  const target = matches[matches.length - 1];
  target.psych = text;
  savePortfolio(p);
  return { id: target.id, code: target.code, shares: target.shares, price: target.price, date: target.date, psych: target.psych };
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