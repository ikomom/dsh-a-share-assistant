// 缓存核心：索引 / 快照 / 查询(TTL) / 清理(三档保留)
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CACHE_ROOT } from './config.js';

export const TYPE_TTL = {
  // 类型: TTL(小时)。过期判定 = fetched_at + ttl
  'limit-up': 24,        // 涨停：每日
  'dragon-tiger': 24,    // 龙虎榜：每日
  sectors: 24,           // 板块：每日
  watchlist: 24,         // 自选股行情：每日
  news: 1,               // 新闻：每小时
  announcements: 1,      // 公告：每小时
  profile: 24 * 30,      // 基本资料：30 天
  finance: 24 * 90,      // 财务：季度
  indicators: 24 * 90,   // 财务指标：季度
  income: 24 * 90,       // 利润表：季度
  balance: 24 * 90,      // 资产负债表：季度
  cashflow: 24 * 90,     // 现金流量表：季度
  kline: 24 * 7,         // 历史K线：周
  quote: 24,             // 个股实时行情：每日
  event: 24,             // 异动/事件：每日
  auction: 1,            // 集合竞价：每小时
  'hot-stock': 24,       // 热股榜：每日
  index: 24,             // 指数行情：每日
  shareholders: 24 * 7,  // 股东：周
};

/** 未在 TYPE_TTL 中声明的类型兜底 TTL：24 小时（避免"未知类型永不过期"的陈旧缓存） */
export const DEFAULT_TTL_HOURS = 24;

export function ttlHoursFor(type) {
  return TYPE_TTL[type] ?? DEFAULT_TTL_HOURS;
}

export const TYPE_LABEL = {
  'limit-up': '涨停',
  'dragon-tiger': '龙虎榜',
  sectors: '板块',
  watchlist: '自选股行情',
  news: '新闻',
  announcements: '公告',
  profile: '基本资料',
  finance: '财务',
  shareholders: '股东',
};

const INDEX_PATH = path.join(CACHE_ROOT, 'index.json');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readIndex() {
  try {
    return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  } catch {
    return { schemaVersion: 1, updatedAt: null, types: {} };
  }
}

function writeIndex(index) {
  index.updatedAt = new Date().toISOString();
  ensureDir(CACHE_ROOT);
  // 原子写：临时文件 + rename
  const tmp = INDEX_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2));
  fs.renameSync(tmp, INDEX_PATH);
}

function atomicWrite(file, data) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Windows/跨平台文件名安全化：非法字符（含冒号、路径分隔符等）替换为下划线 */
export function safeFilePart(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_');
}

/**
 * 个股数据归属校验/过滤：data 疑似多标的（全市场/批量返回）时，
 * 按目标 code 过滤出该标的条目（thscode 或 ticker 精确匹配）。
 * 过滤不到时不改动（避免误删）；单标的原样返回。
 */
export function filterByCode(data, code) {
  const items = Array.isArray(data) ? data : data?.item;
  if (!Array.isArray(items)) return data;
  const pure = String(code).split('.')[0];
  const distinct = new Set(items.map((i) => i.thscode || i.ticker || ''));
  const multi = data?.total > 1 || distinct.size > 1;
  if (!multi) return data;
  const mine = items.filter((i) => {
    const t = String(i.thscode || i.ticker || '');
    return t === code || t === pure;
  });
  if (mine.length === 0) return data;
  const filtered = Array.isArray(data) ? mine : { ...data, item: mine, total: mine.length, filteredFrom: items.length };
  console.warn(`[缓存] 数据疑似多标的（${items.length} 条），已按 ${code} 过滤为 ${mine.length} 条后落盘/返回`);
  return filtered;
}

// ── 写入 ───────────────────────────────────────────────────────────────────

/**
 * 保存一份快照（daily）：snapshots/YYYY-MM-DD/<type>.json
 * type 会做文件名安全化（冒号等非法字符 → 下划线）；同日期同类型重复写入给出告警。
 */
export function saveSnapshot({ type, date, data }) {
  const safeType = safeFilePart(type);
  const file = path.join(CACHE_ROOT, 'snapshots', date, `${safeType}.json`);
  if (fs.existsSync(file)) {
    console.warn(`[缓存] 覆盖写入: ${file}（同类型同日期的既有数据将被替换）`);
  }
  atomicWrite(file, data);
  const index = readIndex();
  const rec = index.types[type] || {};
  rec.latest = date;
  rec.fetchedAt = new Date().toISOString();
  index.types[type] = rec;
  writeIndex(index);
  return file;
}

/**
 * 保存个股级缓存：stocks/<code>/<type>.json
 * 同一 code+type 重复写入给出告警；code 与 type 均做文件名安全化。
 */
export function saveStock({ code, type, data }) {
  const safeCode = safeFilePart(code);
  const safeType = safeFilePart(type);
  const file = path.join(CACHE_ROOT, 'stocks', safeCode, `${safeType}.json`);
  const filtered = filterByCode(data, code); // 归属校验：全市场/多标的 → 过滤为单标的
  if (fs.existsSync(file)) {
    console.warn(`[缓存] 覆盖写入: ${file}（同一标的同类型的既有数据将被替换）`);
  }
  atomicWrite(file, filtered);
  const index = readIndex();
  const key = `stock:${code}:${type}`;
  const rec = index.types[key] || {};
  rec.fetchedAt = new Date().toISOString();
  rec.kind = 'stock';
  index.types[key] = rec;
  writeIndex(index);
  return file;
}

// ── 查询 ───────────────────────────────────────────────────────────────────

function isExpired(rec, type) {
  if (!rec || !rec.fetchedAt) return true;
  const ttlH = ttlHoursFor(type);
  const ageMs = Date.now() - new Date(rec.fetchedAt).getTime();
  return ageMs > ttlH * 3600 * 1000;
}

/**
 * 取最近一份。返回 { hit, file, data, date, expired }
 */
export function latest(type) {
  const index = readIndex();
  const rec = index.types[type];
  if (!rec || !rec.latest) return { hit: false, expired: true };
  const file = path.join(CACHE_ROOT, 'snapshots', rec.latest, `${type}.json`);
  if (!fs.existsSync(file)) return { hit: false, expired: true };
  const expired = isExpired(rec, type);
  return { hit: true, expired, file, date: rec.latest, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

/**
 * 取个股缓存最新一份：stocks/<code>/<type>.json
 */
export function stockLatest(code, type) {
  const safeCode = safeFilePart(code);
  const safeType = safeFilePart(type);
  const file = path.join(CACHE_ROOT, 'stocks', safeCode, `${safeType}.json`);
  if (!fs.existsSync(file)) return { hit: false, file };
  const index = readIndex();
  const rec = index.types[`stock:${code}:${type}`];
  const expired = rec ? isExpired(rec, type) : true;
  const data = filterByCode(JSON.parse(fs.readFileSync(file, 'utf8')), code); // 读取时同样按标的过滤
  return { hit: true, expired, file, data };
}

/**
 * 取指定日期的快照。
 */
export function getByDate(type, date) {
  const file = path.join(CACHE_ROOT, 'snapshots', date, `${type}.json`);
  if (!fs.existsSync(file)) return { hit: false, file };
  const index = readIndex();
  const rec = index.types[type];
  const expired = rec ? isExpired(rec, type) : true;
  return { hit: true, expired, file, date, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
}

// ── 状态与清理 ─────────────────────────────────────────────────────────────

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) total += dirSize(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

export function status() {
  const index = readIndex();
  const now = Date.now();
  const rows = Object.entries(index.types).map(([key, rec]) => {
    const type = key.startsWith('stock:') ? key.split(':')[2] : key;
    const expired = isExpired(rec, type);
    return {
      key,
      label: key.startsWith('stock:') ? key : TYPE_LABEL[key] || key,
      latest: rec.latest || '—',
      fetchedAt: rec.fetchedAt ? new Date(rec.fetchedAt).toISOString().slice(0, 19).replace('T', ' ') : '—',
      state: expired ? '过期' : '有效',
    };
  });
  return {
    cacheRoot: CACHE_ROOT,
    sizeBytes: dirSize(CACHE_ROOT),
    sizeHuman: (dirSize(CACHE_ROOT) / 1024).toFixed(1) + ' KB',
    rows,
  };
}

/**
 * 三档保留：近 keepDays 天散装；更早的完整自然月打包 zip；超过 archiveMonths 删除。
 */
export function clean({ keepDays = 30, archiveMonths = 12 } = {}) {
  const snapDir = path.join(CACHE_ROOT, 'snapshots');
  if (!fs.existsSync(snapDir)) return { archived: [], deleted: [] };
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - keepDays); // 窗口起点：此日期之后散装保留

  const archived = [];
  const deleted = [];
  for (const entry of fs.readdirSync(snapDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const date = new Date(entry.name); // YYYY-MM-DD
    if (Number.isNaN(date.getTime())) continue;
    if (date >= cutoff) continue; // 仍在 30 天窗口内

    const month = entry.name.slice(0, 7); // YYYY-MM
    const ageMonths = (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());

    if (ageMonths >= archiveMonths) {
      // 超期：整月删除
      const monthDir = path.join(snapDir, month);
      if (fs.existsSync(monthDir)) {
        fs.rmSync(monthDir, { recursive: true, force: true });
        deleted.push(month);
      }
      fs.rmSync(path.join(snapDir, entry.name), { recursive: true, force: true });
      deleted.push(entry.name);
      continue;
    }

    // 整月窗口判断：只有当该月所有日期都早于窗口起点，才打包
    const lastDayOfMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    if (lastDayOfMonth < cutoff) {
      // 整个月已经滑出窗口 → 打包 zip
      const archDir = path.join(CACHE_ROOT, 'archive');
      ensureDir(archDir);
      const zipPath = path.join(archDir, `${month}.zip`);
      // 收集该月所有文件（可能跨天），用 fflate 或系统 zip？v0.1 用简单方案：目录复制为 <month>/ 后压缩
      // 简化实现：把该月所有天目录暂移入 <month>/ 再逐文件写入 zip（这里先做目录移动，zip 压缩留待 v0.2）
      const monthDir = path.join(snapDir, month);
      ensureDir(monthDir);
      for (const day of fs.readdirSync(snapDir, { withFileTypes: true })) {
        if (!day.isDirectory()) continue;
        if (day.name.startsWith(month)) {
          fs.renameSync(path.join(snapDir, day.name), path.join(monthDir, day.name));
        }
      }
      archived.push(month);
    }
  }
  return { archived, deleted };
}