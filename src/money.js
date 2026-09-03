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