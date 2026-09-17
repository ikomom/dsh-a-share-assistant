// 金额精确工具：内部一律用"分"（整数）运算，避免 JS 浮点误差（如 0.1+0.2=0.3000000004）。
// 输入"元"（数字/字符串），输出"分"（整数）；分 → 元用 formatYuan 精确到两位。

/** 元 → 分（整数）。"1500.5"→150050；0.30000000004→30（0.30）。 */
export function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim().replace(/[,$\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const int = m[2] || '0';
  // 小数取前 2 位（分），更长的按第 3 位四舍五入到分
  const fracAll = m[3] || '';
  let fen;
  if (fracAll.length <= 2) {
    fen = Number((fracAll + '00').padEnd(2, '0').slice(0, 2));
  } else {
    const third = Number(fracAll[2]);
    fen = Number(fracAll.slice(0, 2));
    if (third >= 5) fen += 1; // 四舍五入到分（如 0.005 -> 1 分）
  }
  return sign * (Number(int) * 100 + fen);
}

/** 分 → 元字符串（精确两位）。150050 → "1500.50"。 */
export function formatYuan(cents) {
  const c = Math.round(Number(cents));
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const yuan = Math.floor(abs / 100);
  const fen = Math.abs(abs % 100);
  return `${sign}${yuan}.${String(fen).padStart(2, '0')}`;
}

// ── 行情价专用：厘（0.001 元）─────────────────────────────────────────────
// 建仓/手续费等成交金额仍以「分」为准；但 ETF/基金报价最小变动 0.001 元，
// 用分记价会把 4.532 压成 4.53，乘以股数后市值/浮盈出现偏差。
// 故行情价内部用「厘」整数存，市值/浮盈 = 厘×股数/10 后再四舍五入到分。

/** 元 → 厘（整数）。"4.532"→4532；"13.36"→13360。 */
export function toMilli(value) {
  if (value === null || value === undefined || value === '') return 0;
  const s = String(value).trim().replace(/[,$\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return 0;
  const sign = m[1] === '-' ? -1 : 1;
  const int = m[2] || '0';
  const frac = ((m[3] || '') + '000').slice(0, 4); // 多取一位用于四舍五入
  let li = Number(frac.slice(0, 3));
  if (Number(frac[3]) >= 5) li += 1;
  return sign * (Number(int) * 1000 + li);
}

/** 厘 → 元字符串。4532 → "4.532"（digits=3）；13360 → "13.36"（digits=2）。 */
export function formatMilli(milli, digits = 2) {
  const c = Math.round(Number(milli));
  const sign = c < 0 ? '-' : '';
  const abs = Math.abs(c);
  const yuan = Math.floor(abs / 1000);
  const rest = String(abs % 1000).padStart(3, '0');
  return digits >= 3 ? `${sign}${yuan}.${rest}` : `${sign}${yuan}.${rest.slice(0, 2)}`;
}

/** 厘 × 股数 → 分（四舍五入）。4532(厘) × 1000股 = 453200 分 = 4532.00 元 */
export function milliTimesSharesToCents(milli, shares) {
  return Math.round((Number(milli) * Number(shares)) / 10);
}