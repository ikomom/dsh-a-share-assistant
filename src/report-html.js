// 持仓分析单文件 HTML 报告：内联 CSS + 内联 ECharts（assets/echarts.min.js），浅色主题、涨红跌绿（A股惯例）。
// 风格 token 照《复盘模板生成指南》§4：圆角卡片、分组色带、三色 pill、单文件可直接打开。
// ECharts 本地内联：断网/外链被墙也能出图（缺失时回退 CDN）。
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { formatYuan, formatMilli } from './money.js';

const C_UP = '#e23c3c';    // 涨 / 盈利 / 计划买区
const C_DOWN = '#1a9e5f';  // 跌 / 亏损 / 破止损
const C_GOLD = '#d99100';  // 止盈 / 接近目标
const C_BLUE = '#2f6fed';  // 中性信息
const C_INK = '#4b5563';   // 次级文字
const C_LINE = '#eceef1';  // 分隔线
const PIE_PALETTE = [C_UP, C_BLUE, C_GOLD, C_DOWN, '#7c5cff', '#00a3a3', '#d94f9c', '#8a9aa8'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const yuan = (c) => (c === null || c === undefined ? '—' : formatYuan(c));
// 行情价（厘）→ 元：ETF/基金三位小数，股票两位
const pr = (m) => (m === null || m === undefined || m === '' ? '—' : formatMilli(m, Number(m) % 10 === 0 ? 2 : 3));
const pctText = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
const pctClass = (v) => (v === null || v === undefined || v === 0 ? '' : v > 0 ? 'up' : 'down');

const GROUP_META = {
  stop: { title: '⚠️ 止损预警组', cls: 'g-stop' },
  target: { title: '🎯 止盈组', cls: 'g-hold' },
  zone: { title: '✅ 计划买区组', cls: 'g-buy' },
  hold: { title: '➖ 持有观察组', cls: 'g-watch' },
};

/** ECharts 脚本：优先内联本地文件（离线可用），缺失则回退 CDN */
function echartsTag() {
  const file = path.join(PROJECT_ROOT, 'assets', 'echarts.min.js');
  try {
    const js = fs.readFileSync(file, 'utf8');
    if (js.length > 100000) return `<script>${js}</script>`;
  } catch { /* 回退 CDN */ }
  return '<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>';
}

function stockCard(r) {
  const planBits = [];
  if (r.zoneLow || r.zoneHigh) planBits.push(`买入区 ${pr(r.zoneLow)}${r.zoneHigh ? `-${pr(r.zoneHigh)}` : ''}`);
  if (r.target) planBits.push(`目标 ${pr(r.target)}`);
  if (r.stop) planBits.push(`止损 ${pr(r.stop)}`);
  const meta = planBits.length ? planBits.join(' ｜ ') : '未设计划参数（仅成本盈亏分析）';
  // 持仓来源：建仓日 + 已持有天数 + 最近一笔 —— 明确"这是存量持仓，不是今天买的"
  const held = [
    r.openDate ? `建仓 ${esc(r.openDate)}${r.holdingDays !== null && r.holdingDays !== undefined ? `（已持有 ${r.holdingDays} 天）` : ''}` : '',
    r.lastTrade ? `最近一笔 ${esc(r.lastTrade.date)}${r.lastTrade.time ? ' ' + esc(r.lastTrade.time) : ''} ${r.lastTrade.type === 'buy' ? '买入' : '卖出'} ${r.lastTrade.shares}股 @${formatMilli(r.lastTrade.price * 10, 2)}` : '（无交易流水）',
    r.tradeCount ? `累计 ${r.tradeCount} 笔` : '',
  ].filter(Boolean).join(' ｜ ');
  return `
  <div class="stock">
    <div class="head"><span class="name">${esc(r.name)}</span><span class="code">${esc(r.code)}${r.isEtf ? ' · ETF' : ''}</span>
      <span class="dir">${r.shares}股 · 成本 ${yuan(r.avgCost)}</span><span class="trig ${r.group}">${esc(r.badge)}</span></div>
    <div class="datarow">现价 <span class="${pctClass(r.changePct)}">${pr(r.priceMilli)}</span>
      （${pctText(r.changePct)}）｜ 开 ${pr(r.openMilli)} 高 ${pr(r.highMilli)} 低 ${pr(r.lowMilli)} ｜ 市值 ${yuan(r.marketValue)} ｜ 浮动
      <span class="${pctClass(r.floatPnl)}">${yuan(r.floatPnl)}（${pctText(r.floatPnlPct)}）</span></div>
    <div class="note">${held}</div>
    <div class="note">${meta}${r.stop ? ` ｜ 距止损 ${pctText(r.distStopPct)}` : ''}${r.target ? ` ｜ 距目标 ${pctText(r.distTargetPct)}` : ''} ｜ 数据源 ${esc(r.dataSource)}</div>
    <div class="op"><b>操作：</b>${esc(r.action)}</div>
  </div>`;
}

/**
 * 生成持仓分析 HTML（单文件；ECharts 内联，断网可用）。
 * @param {object} p
 * @param {object} p.analysis analyzeHoldings() 的返回值
 * @param {object} [p.market]   fetchMarketContext() 的返回值（大盘/板块/情绪）
 * @param {Array}  [p.events]   风险日历条目 [{date,title,impact?,source?}]
 * @param {object} [p.options]  {generatedAt, marketErrors}
 */
export function buildHoldingsHtml(p) {
  const a = p.analysis ?? p;
  const market = p.market ?? null;
  const events = (p.events ?? []).filter((e) => e && (e.date || e.title));
  const s = a.summary;
  const named = a.rows.map((r) => ({ ...r, label: r.name && r.name !== r.code ? `${r.name}(${r.code})` : r.code }));
  const d = a.date;
  const tldr = [
    `持仓 ${s.count} 只，投入成本 ${yuan(s.costC)}，市值 ${yuan(s.marketValueC)}`,
    `浮动盈亏 ${yuan(s.floatPnlC)}（${pctText(s.floatPnlPct)}）`,
    s.groupCounts.stop ? `⚠️ 止损预警 ${s.groupCounts.stop} 只` : '',
    s.groupCounts.target ? `🎯 止盈 ${s.groupCounts.target} 只` : '',
    s.groupCounts.zone ? `✅ 回到买区 ${s.groupCounts.zone} 只` : '',
    s.groupCounts.hold ? `➖ 持有观察 ${s.groupCounts.hold} 只` : '',
  ].filter(Boolean).join('；');

  const overview = named.map((r) => `<tr>
      <td>${esc(r.name)}<br><span class="code">${esc(r.code)}${r.isEtf ? ' · ETF' : ''}</span></td>
      <td class="num">${r.shares}</td><td class="num">${yuan(r.avgCost)}</td>
      <td class="num ${pctClass(r.changePct)}">${pr(r.priceMilli)}</td>
      <td class="num ${pctClass(r.changePct)}">${pctText(r.changePct)}</td>
      <td class="num">${r.stop ? pr(r.stop) : '—'}</td><td class="num">${r.target ? pr(r.target) : '—'}</td>
      <td class="num ${pctClass(r.floatPnl)}">${yuan(r.floatPnl)}（${pctText(r.floatPnlPct)}）</td>
      <td>${esc(r.badge)}</td></tr>`).join('');

  const groupHtml = a.groups.map((g) => {
    const meta = GROUP_META[g.group];
    return `<div class="group-h ${meta.cls}">${meta.title}（${g.rows.length} 只）</div>${g.rows.map(stockCard).join('')}`;
  }).join('');

  // ── 市场环境块 ────────────────────────────────────────────────────────────
  const idxCards = market?.indices?.length
    ? market.indices.map((x) => `<div class="idx">
        <div class="idx-name">${esc(x.name)}<span class="code"> ${esc(x.code)}</span></div>
        <div class="idx-val ${pctClass(x.changePct)}">${x.last === null ? '—' : x.last.toFixed(2)}</div>
        <div class="idx-chg ${pctClass(x.changePct)}">${x.change === null ? '—' : (x.change > 0 ? '+' : '') + x.change.toFixed(2)}（${pctText(x.changePct)}）</div>
      </div>`).join('')
    : '<div class="empty">指数行情未取到</div>';

  const breadth = market?.breadth;
  const ladder = market?.ladder;
  const mb = market?.marketBreadth;
  const sentiment = breadth
    ? `<div class="sent">
        <span class="pill buy">涨停 ${breadth.limitUp}</span>
        <span class="pill watch">跌停 ${breadth.limitDown}</span>
        <span class="pill info">炸板 ${breadth.limitBreak}</span>
        <span class="pill hold">封板率 ${breadth.sealRate === null ? '—' : breadth.sealRate + '%'}</span>
        ${ladder && ladder.maxBoard ? `<span class="pill info">最高 ${ladder.maxBoard} 板${ladder.maxBoardNames.length ? '（' + esc(ladder.maxBoardNames.join('、')) + '）' : ''}</span>` : ''}
        ${mb ? `<span class="pill buy">全市场涨 ${mb.up}</span><span class="pill watch">跌 ${mb.down}</span><span class="pill info">平 ${mb.flat}（共 ${mb.total} 只）</span>` : ''}
        ${market?.sectors?.flatLine ? `<span class="pill info">概念涨 ${market.sectors.flatLine.up} / 跌 ${market.sectors.flatLine.down}</span>` : ''}
      </div>`
    : '<div class="empty">涨跌停情绪未取到</div>';

  const sectorTable = market?.sectors?.gainers?.length
    ? `<table>
        <tr><th>领涨概念</th><th style="text-align:right">涨幅</th><th>领跌概念</th><th style="text-align:right">跌幅</th></tr>
        ${market.sectors.gainers.map((g, i) => {
          const l = market.sectors.losers[i] || {};
          return `<tr><td>${esc(g.name)}</td><td class="num up">${pctText(g.changePct)}</td><td>${esc(l.name || '')}</td><td class="num down">${l.changePct === undefined ? '' : pctText(l.changePct)}</td></tr>`;
        }).join('')}
      </table>`
    : '<div class="empty">板块行情未取到</div>';

  const tradeRows = (a.trades ?? []).map((t) => `<tr>
      <td>${esc(t.time || '')}</td>
      <td>${esc(t.name)}<br><span class="code">${esc(t.code)}</span></td>
      <td><span class="tag ${t.type === 'buy' ? 'buy' : 'sell'}">${t.type === 'buy' ? '买入' : '卖出'}</span></td>
      <td class="num">${t.shares}</td><td class="num">${formatMilli(t.price * 10, 2)}</td>
      <td class="num">${yuan(t.amount)}</td><td class="num">${yuan(t.fee)}</td>
      <td class="num ${pctClass(t.realizedPnl)}">${t.realizedPnl === null ? '—' : yuan(t.realizedPnl)}</td>
      <td class="note-small">${esc(t.psych || t.note || '')}</td></tr>`).join('');

  const eventRows = events.length
    ? events.map((e) => `<tr><td>${esc(e.date || '')}</td><td>${esc(e.title || '')}</td><td>${esc(e.impact || '')}</td><td class="note-small">${esc(e.source || '')}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">未提供。复盘时可用 web 搜索补齐（宏观数据发布、解禁、会议、财报窗口等），并在「来源」列标注链接——本页不编造事件。</td></tr>`;

  const rangeRows = named.filter((r) => r.stop && r.target && r.target > r.stop);
  const chartData = {
    names: named.map((r) => r.label),
    pnlPct: named.map((r) => r.floatPnlPct ?? 0),
    changePct: named.map((r) => r.changePct ?? 0),
    marketValue: named.map((r) => Math.round(r.marketValue / 100)),
    rangePos: rangeRows.map((r) => ({
      name: r.label,
      pos: Math.round(((r.priceMilli - r.stop) / (r.target - r.stop)) * 1000) / 10,
      price: r.priceMilli, stop: r.stop, target: r.target,
    })),
    idxNames: (market?.indices ?? []).map((x) => x.name),
    idxPct: (market?.indices ?? []).map((x) => x.changePct ?? 0),
    secUpNames: (market?.sectors?.gainers ?? []).map((x) => x.name),
    secUpPct: (market?.sectors?.gainers ?? []).map((x) => x.changePct),
    secDownNames: (market?.sectors?.losers ?? []).map((x) => x.name),
    secDownPct: (market?.sectors?.losers ?? []).map((x) => x.changePct),
  };
  const h = (n) => Math.max(170, n * 54 + 70); // 图表高度随持仓数自适应，避免大片留白
  const marketErrors = (p.options?.marketErrors ?? market?.errors ?? []);

  const dataDay = market?.tradeDate || d;
  const dayNote = dataDay !== d ? `（${d} 非交易日，行情取最近交易日 ${dataDay} 收盘）` : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>持仓股分析 · ${esc(d)}</title>
${echartsTag()}
<style>
  *{box-sizing:border-box}
  body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#292d35;max-width:960px;margin:0 auto;padding:24px 20px 48px;line-height:1.55}
  h1{font-size:23px;margin:0 0 6px;letter-spacing:.2px}
  h2{font-size:17px;margin:28px 0 10px}
  .sub{color:#6b7280;font-size:13.5px;margin-bottom:10px}
  .meta{font-size:12.5px;color:#6b7280;background:#eef1f4;border-radius:8px;padding:8px 12px;margin-bottom:6px}
  .card{background:#fff;border:1px solid #e6e8ec;border-radius:10px;padding:16px;margin:12px 0;box-shadow:0 1px 3px rgba(0,0,0,.04)}
  .tldr{background:#fff8f0;border-color:#f0d9b5}
  .tldr h3{margin:0 0 6px;font-size:15px}
  .tldr p{margin:0 0 10px;font-size:14px}
  .pill{display:inline-block;border-radius:999px;padding:4px 12px;font-size:12.5px;font-weight:600;margin:2px 8px 2px 0}
  .pill.buy{background:#fde8e8;color:${C_UP}}
  .pill.hold{background:#fff3df;color:${C_GOLD}}
  .pill.watch{background:#e8f5ee;color:${C_DOWN}}
  .pill.info{background:#eaf0ff;color:${C_BLUE}}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid ${C_LINE};padding:9px 8px;text-align:left;vertical-align:top}
  th{color:#6b7280;font-weight:600;background:#fafbfc}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .up{color:${C_UP};font-weight:600}.down{color:${C_DOWN};font-weight:600}
  .code{color:#6b7280;font-size:12px}
  .group-h{padding:9px 12px;border-radius:8px;font-weight:700;margin:20px 0 8px;font-size:14px}
  .g-buy{background:#fde8e8;color:${C_UP}}
  .g-hold{background:#fff3df;color:${C_GOLD}}
  .g-stop{background:#e8f5ee;color:${C_DOWN}}
  .g-watch{background:#eef1f4;color:${C_INK}}
  .stock{background:#fff;border:1px solid #e6e8ec;border-radius:10px;padding:14px;margin:10px 0}
  .head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:700;font-size:14px}
  .dir{font-size:12px;color:#6b7280;background:#f0f1f3;padding:2px 8px;border-radius:6px;font-weight:400}
  .trig{font-size:12px;padding:2px 8px;border-radius:6px;font-weight:600;background:#f0f1f3;color:${C_INK}}
  .trig.stop{background:#e8f5ee;color:${C_DOWN}}
  .trig.target{background:#fff3df;color:${C_GOLD}}
  .trig.zone{background:#fde8e8;color:${C_UP}}
  .datarow{font-size:13px;color:${C_INK};margin:8px 0}
  .note{font-size:12px;color:#6b7280;margin:6px 0}
  .note-small{font-size:11.5px;color:#8b93a1}
  .op{font-size:13px;background:#f7f8fa;padding:8px 10px;border-radius:8px}
  .chart{width:100%}
  .empty{color:#9aa0a6;font-size:13px;padding:8px 0}
  .idxs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
  .idx{background:#fafbfc;border:1px solid ${C_LINE};border-radius:8px;padding:10px 12px}
  .idx-name{font-size:12.5px;color:#6b7280}
  .idx-val{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;margin:2px 0}
  .idx-chg{font-size:12.5px}
  .sent{margin:4px 0 12px}
  .tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .tag.buy{background:#fde8e8;color:${C_UP}}
  .tag.sell{background:#e8f5ee;color:${C_DOWN}}
  .chart-title{font-size:14.5px;color:${C_INK};margin:16px 0 6px;font-weight:600}
  .foot{font-size:12px;color:#9aa0a6;margin-top:28px;border-top:1px solid ${C_LINE};padding-top:12px}
  .foot b{color:#6b7280}
</style>
</head>
<body>

<h1>持仓股分析 · ${esc(d)}</h1>
<div class="sub">今日大盘与板块环境 → 台账持仓的计划对照 → 触发状态与操作取向</div>
<div class="meta">行情截至 ${esc(dataDay)}${dayNote} ｜ 账户 ${esc(a.account || '默认')} ｜ 数据来源 同花顺金融数据API（fuyao.aicubes.cn） ｜ 持仓行情口径 ${a.rows.some((r) => r.dataSource === '实时快照') ? '实时快照' : '最近交易日日线'}${market?.indexDate ? ` ｜ 指数 ${esc(market.indexDate)}` : ''}${market?.breadth?.date ? ` ｜ 涨跌停 ${esc(market.breadth.date)}` : ''} ｜ 生成时间 ${esc(p.options?.generatedAt || a.generatedAt || '')}</div>

<div class="card tldr">
  <h3>⚡ 一句话结论</h3>
  <p>${esc(tldr)}</p>
  <span class="pill info">成本 ${yuan(s.costC)}</span>
  <span class="pill info">市值 ${yuan(s.marketValueC)}</span>
  <span class="pill ${s.floatPnlC >= 0 ? 'buy' : 'watch'}">浮动盈亏 ${yuan(s.floatPnlC)}（${pctText(s.floatPnlPct)}）</span>
  ${s.groupCounts.zone ? `<span class="pill buy">可低吸 ${s.groupCounts.zone} 只</span>` : ''}
  ${s.groupCounts.target ? `<span class="pill hold">止盈 ${s.groupCounts.target} 只</span>` : ''}
  ${s.groupCounts.stop ? `<span class="pill watch">止损预警 ${s.groupCounts.stop} 只</span>` : ''}
  ${s.tradeCount ? `<span class="pill info">今日交易 ${s.tradeCount} 笔</span>` : ''}
</div>

<h2>一、今日大盘</h2>
<div class="card">
  <div class="idxs">${idxCards}</div>
  ${sentiment}
  <div id="idxChart" class="chart" style="height:${Math.max(150, market?.indices?.length * 42 + 60 || 190)}px"></div>
  ${marketErrors.length ? `<div class="empty">⚠ 部分数据未取到：${esc(marketErrors.join('；'))}</div>` : ''}
</div>

<h2>二、板块表现${market?.sectors?.total ? `（概念 ${market.sectors.total} 个）` : ''}</h2>
<div class="card">
  ${sectorTable}
  ${market?.sectors?.gainers?.length ? '<div id="secChart" class="chart" style="height:' + h(market.sectors.gainers.length + market.sectors.losers.length) + 'px"></div>' : ''}
</div>

<h2>三、今日交易流水${s.tradeCount ? `（${s.tradeCount} 笔）` : ''}</h2>
<div class="card">
  ${s.tradeCount
    ? `<table>
        <tr><th>时间</th><th>标的</th><th>方向</th><th style="text-align:right">股数</th><th style="text-align:right">成交价</th><th style="text-align:right">金额</th><th style="text-align:right">手续费</th><th style="text-align:right">已实现</th><th>备注</th></tr>
        ${tradeRows}
      </table>
      <div class="note">当日合计：手续费 ${yuan(s.dayFeesC)} ｜ 已实现盈亏 ${yuan(s.dayRealizedC)}</div>`
    : '<div class="empty">今日无交易流水（台账里没有当日买卖记录）</div>'}
</div>

<h2>四、持仓逐只分析（${named.length} 只）</h2>
<div class="card">
  <table>
    <tr><th>名称/代码</th><th style="text-align:right">股数</th><th style="text-align:right">成本</th><th style="text-align:right">现价</th><th style="text-align:right">当日</th><th style="text-align:right">止损</th><th style="text-align:right">目标</th><th style="text-align:right">浮动盈亏</th><th>触发状态</th></tr>
    ${overview || '<tr><td colspan="9" class="empty">（台账无持仓）</td></tr>'}
  </table>
</div>

<h3 class="chart-title">浮动盈亏率（%）</h3>
<div class="card"><div id="pnlChart" class="chart" style="height:${h(named.length)}px"></div></div>

<h3 class="chart-title">当日涨跌幅（%）</h3>
<div class="card"><div id="chgChart" class="chart" style="height:${h(named.length)}px"></div></div>

<h3 class="chart-title">持仓市值占比</h3>
<div class="card"><div id="mvChart" class="chart" style="height:${Math.max(260, named.length * 26 + 180)}px"></div></div>

${rangeRows.length ? `<h3 class="chart-title">计划区间位置（止损 = 0% → 目标 = 100%）</h3>
<div class="card"><div id="rangeChart" class="chart" style="height:${h(rangeRows.length)}px"></div></div>` : ''}

${groupHtml || '<div class="card empty">（台账无持仓）</div>'}

<h2>五、风险日历（未来 3–5 日）</h2>
<div class="card">
  <table>
    <tr><th>日期</th><th>事件</th><th>可能影响</th><th>来源</th></tr>
    ${eventRows}
  </table>
</div>

<div class="foot">
  <p><b>分析说明：</b>本页为台账持仓（${esc(a.account || '默认账户')}）的计划对照分析，止损/目标/买入区沿用台账记录，不做改动；行情、指数、板块与涨跌停数据来自同花顺金融数据 API，逐只判定规则为「当日最低价 ≤ 买入区上沿 且 收盘 ≥ 止损 → 可低吸；触/逼目标 → 止盈；破位/逼近止损 → 止损预警」，只标注「计划 vs 现实」的偏差。持仓卡片中的「建仓 / 最近一笔」用于区分**存量持仓**与**今日交易**。</p>
  <p><b>风险提示：</b>本页仅基于公开市场数据与用户自记台账做客观标注，不含主观分析，不构成投资建议或证券投资咨询服务；市场有风险，决策需谨慎，请以交易所官方数据为准。</p>
</div>

<script>
var DATA = ${JSON.stringify(chartData)};
var UP = '${C_UP}', DOWN = '${C_DOWN}', GOLD = '${C_GOLD}', BLUE = '${C_BLUE}', INK = '${C_INK}', LINE = '${C_LINE}';
var PIE = ${JSON.stringify(PIE_PALETTE)};
var AXIS = {axisLine:{lineStyle:{color:'#e6e8ec'}},axisLabel:{color:INK,fontSize:11.5},axisTick:{show:false}};
var charts = [];
function init(id, option){
  var el = document.getElementById(id); if(!el || typeof echarts === 'undefined') return null;
  var c = echarts.init(el); c.setOption(option); charts.push(c); return c;
}
function barOption(values, unit){
  return {
    grid:{left:6,right:52,top:12,bottom:6,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:function(v){return v+unit;}},
    xAxis:Object.assign({type:'value',splitLine:{lineStyle:{color:LINE}}}, AXIS),
    yAxis:Object.assign({type:'category',data:DATA.names,inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:20,
      data:values.map(function(v){return {value:v,itemStyle:{color:v>=0?UP:DOWN,borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}};}),
      label:{show:true,position:'right',formatter:function(p){return p.value+unit;},fontSize:11.5,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#d7dbe0',type:'dashed'},data:[{xAxis:0}]}
    }]
  };
}
init('pnlChart', barOption(DATA.pnlPct, '%'));
init('chgChart', barOption(DATA.changePct, '%'));
init('mvChart', {
  color:PIE,
  tooltip:{trigger:'item',valueFormatter:function(v){return v+' 元';}},
  legend:{bottom:0,itemWidth:12,itemHeight:12,textStyle:{color:INK,fontSize:12}},
  series:[{
    type:'pie', radius:['44%','66%'], center:['50%','44%'],
    itemStyle:{borderColor:'#fff',borderWidth:2},
    data:DATA.names.map(function(n,i){return {name:n,value:DATA.marketValue[i]};}),
    label:{color:INK,fontSize:11.5,formatter:'{b}\\n{d}%'},
    labelLine:{lineStyle:{color:'#c9ced6'}}
  }]
});
if (DATA.rangePos.length){
  init('rangeChart', {
    grid:{left:6,right:56,top:22,bottom:6,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:function(ps){
      var d = DATA.rangePos[ps[0].dataIndex];
      var y = function(m){ return (m%10===0) ? (m/1000).toFixed(2) : (m/1000).toFixed(3); };
      return d.name+'<br>止损 ¥'+y(d.stop)+' → 目标 ¥'+y(d.target)+'<br>现价 ¥'+y(d.price)+'<br>区间位置 '+d.pos+'%';
    }},
    xAxis:Object.assign({type:'value',min:0,max:Math.max(100, Math.ceil(Math.max.apply(null, DATA.rangePos.map(function(x){return x.pos;})) / 10) * 10),axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e6e8ec'}},axisTick:{show:false}}),
    yAxis:Object.assign({type:'category',data:DATA.rangePos.map(function(x){return x.name;}),inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:20,
      data:DATA.rangePos.map(function(x){
        var color = x.pos <= 0 ? DOWN : x.pos >= 100 ? GOLD : UP;
        return {value:x.pos,itemStyle:{color:color,borderRadius:[0,4,4,0]}};
      }),
      label:{show:true,position:'right',formatter:'{c}%',fontSize:11.5,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#c9ced6',type:'dashed'},label:{color:'#9aa0a6',fontSize:11},
        data:[{xAxis:0,name:'止损'},{xAxis:100,name:'目标'}]}
    }]
  });
}
// 指数涨跌（大盘）
if (DATA.idxNames.length){
  init('idxChart', {
    grid:{left:6,right:56,top:12,bottom:6,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:function(v){return v+'%';}},
    xAxis:Object.assign({type:'value',axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e6e8ec'}},axisTick:{show:false}}),
    yAxis:Object.assign({type:'category',data:DATA.idxNames,inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:22,
      data:DATA.idxPct.map(function(v){return {value:v,itemStyle:{color:v>=0?UP:DOWN,borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}};}),
      label:{show:true,position:'right',formatter:function(p){return p.value+'%';},fontSize:11.5,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#d7dbe0',type:'dashed'},data:[{xAxis:0}]}
    }]
  });
}
// 板块涨跌（领涨在上、领跌在下，红涨绿跌）
if (DATA.secUpNames.length || DATA.secDownNames.length){
  var secNames = DATA.secUpNames.concat(DATA.secDownNames);
  var secVals = DATA.secUpPct.concat(DATA.secDownPct);
  init('secChart', {
    grid:{left:6,right:56,top:12,bottom:6,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:function(v){return v+'%';}},
    xAxis:Object.assign({type:'value',axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e6e8ec'}},axisTick:{show:false}}),
    yAxis:Object.assign({type:'category',data:secNames,inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:18,
      data:secVals.map(function(v){return {value:v,itemStyle:{color:v>=0?UP:DOWN,borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}};}),
      label:{show:true,position:'right',formatter:function(p){return p.value+'%';},fontSize:11,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#d7dbe0',type:'dashed'},data:[{xAxis:0}]}
    }]
  });
}
window.addEventListener('resize', function(){ charts.forEach(function(c){ c.resize(); }); });
</script>
</body>
</html>
`;
}
