// 持仓分析单文件 HTML 报告：内联 CSS + 内联 ECharts（assets/echarts.min.js），浅色主题、涨红跌绿（A股惯例）。
// 包含：全资产看板、全资产配置环形图、大盘与全市场涨跌体感分布条、情绪卡片、持仓轻仓自适应卡片/多股对比图表、交易流水与风险日历。
// 顶部具备平滑滚动吸顶导航（Sticky Header），单文件自包含、离线优先。
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';
import { formatYuan, formatMilli } from './money.js';

const C_UP = '#e23c3c';       // 涨 / 盈利 / 买区
const C_DOWN = '#1a9e5f';     // 跌 / 亏损 / 止损
const C_GOLD = '#d99100';     // 止盈 / 目标
const C_BLUE = '#2f6fed';     // 股票 / 中性
const C_REPO = '#7c5cff';     // 逆回购
const C_CASH = '#00a3a3';     // 现金
const C_INK = '#374151';      // 正文
const C_MUTED = '#6b7280';    // 次级文字
const C_LINE = '#e5e7eb';     // 分隔线
const PIE_PALETTE = [C_BLUE, C_REPO, C_CASH, C_UP, C_GOLD, C_DOWN, '#d94f9c', '#8a9aa8'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
const yuan = (c) => (c === null || c === undefined ? '—' : formatYuan(c));
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

/** 持仓个股卡片（含自适应计划区间标尺） */
function stockCard(r, totalAssetsC) {
  const planBits = [];
  if (r.zoneLow || r.zoneHigh) planBits.push(`买入区 ${pr(r.zoneLow)}${r.zoneHigh ? `-${pr(r.zoneHigh)}` : ''}`);
  if (r.target) planBits.push(`目标 ${pr(r.target)}`);
  if (r.stop) planBits.push(`止损 ${pr(r.stop)}`);
  const meta = planBits.length ? planBits.join(' ｜ ') : '未设计划参数（仅成本盈亏分析）';

  const held = [
    r.openDate ? `建仓 ${esc(r.openDate)}${r.holdingDays !== null && r.holdingDays !== undefined ? `（已持有 ${r.holdingDays} 天）` : ''}` : '',
    r.lastTrade ? `最近一笔 ${esc(r.lastTrade.date)}${r.lastTrade.time ? ' ' + esc(r.lastTrade.time) : ''} ${r.lastTrade.type === 'buy' ? '买入' : '卖出'} ${r.lastTrade.shares}股 @${formatMilli(r.lastTrade.price * 10, 2)}` : '（无交易流水）',
    r.tradeCount ? `累计 ${r.tradeCount} 笔` : '',
  ].filter(Boolean).join(' ｜ ');

  const assetWeight = totalAssetsC && totalAssetsC > 0 ? ((r.marketValue / totalAssetsC) * 100).toFixed(2) + '%' : '—';

  // 计划区间进度条（Mini Range Bar）
  let rangeHtml = '';
  if (r.stop && r.target && r.target > r.stop) {
    const span = r.target - r.stop;
    const pricePos = Math.min(100, Math.max(0, Math.round(((r.priceMilli - r.stop) / span) * 100)));
    const costPos = (r.avgMilli >= r.stop && r.avgMilli <= r.target) ? Math.round(((r.avgMilli - r.stop) / span) * 100) : null;
    rangeHtml = `
    <div class="range-box">
      <div class="range-labels">
        <span>止损: ¥${pr(r.stop)} (0%)</span>
        <span class="range-curr">现价: ¥${pr(r.priceMilli)} (区间 ${pricePos}%)</span>
        <span>目标: ¥${pr(r.target)} (100%)</span>
      </div>
      <div class="range-track">
        <div class="range-fill ${pricePos >= 100 ? 'target' : pricePos <= 0 ? 'stop' : 'in-range'}" style="width:${pricePos}%"></div>
        ${costPos !== null ? `<div class="range-pin cost" style="left:${costPos}%" title="成本价 ¥${pr(r.avgMilli)}"><span>成本</span></div>` : ''}
        <div class="range-pin price" style="left:${pricePos}%" title="现价 ¥${pr(r.priceMilli)}"><span>现价</span></div>
      </div>
      <div class="range-sub">
        <span>距止损: ${r.distStopPct !== null ? pctText(r.distStopPct) : '—'}</span>
        <span>距目标: ${r.distTargetPct !== null ? pctText(r.distTargetPct) : '—'}</span>
      </div>
    </div>`;
  }

  return `
  <div class="stock">
    <div class="head">
      <span class="name">${esc(r.name)}</span>
      <span class="code">${esc(r.code)}${r.isEtf ? ' · ETF' : ''}</span>
      <span class="dir">${r.shares}股 · 成本 ${yuan(r.avgCost)}</span>
      <span class="weight">占总资产 ${assetWeight}</span>
      <span class="trig ${r.group}">${esc(r.badge)}</span>
    </div>
    <div class="datarow">
      现价 <span class="${pctClass(r.changePct)}">${pr(r.priceMilli)}</span>（${pctText(r.changePct)}）｜
      开 ${pr(r.openMilli)} 高 ${pr(r.highMilli)} 低 ${pr(r.lowMilli)} ｜
      市值 ${yuan(r.marketValue)} ｜
      浮动盈亏 <span class="${pctClass(r.floatPnl)}">${yuan(r.floatPnl)}（${pctText(r.floatPnlPct)}）</span>
    </div>
    ${rangeHtml}
    <div class="note">${held}</div>
    <div class="note">${meta} ｜ 数据源 ${esc(r.dataSource)}</div>
    <div class="op"><b>操作指导：</b>${esc(r.action)}</div>
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

  // 资产底账数据口径对齐
  const cashC = Number(s.cash) || 0;
  const repoPrincipalC = Number(s.repoPrincipalC) || 0;
  const repoInterestC = Number(s.repoInterestC) || 0;
  const marketValueC = Number(s.marketValueC) || 0;
  const totalAssetsC = Number(s.totalAssetsC) || (marketValueC + cashC + repoPrincipalC);

  const stockRatioPct = totalAssetsC > 0 ? ((marketValueC / totalAssetsC) * 100).toFixed(1) : '0.0';
  const repoRatioPct = totalAssetsC > 0 ? ((repoPrincipalC / totalAssetsC) * 100).toFixed(1) : '0.0';
  const cashRatioPct = totalAssetsC > 0 ? ((cashC / totalAssetsC) * 100).toFixed(1) : '0.0';

  const tldr = [
    `总资产 ${yuan(totalAssetsC)}，其中股票市值 ${yuan(marketValueC)}（仓位 ${stockRatioPct}%），国债逆回购 ${yuan(repoPrincipalC)}（${repoRatioPct}%），可用资金 ${yuan(cashC)}（${cashRatioPct}%）`,
    `股票浮动盈亏 ${yuan(s.floatPnlC)}（${pctText(s.floatPnlPct)}）`,
    s.groupCounts?.stop ? `⚠️ 止损预警 ${s.groupCounts.stop} 只` : '',
    s.groupCounts?.target ? `🎯 止盈 ${s.groupCounts.target} 只` : '',
    s.groupCounts?.zone ? `✅ 回到买区 ${s.groupCounts.zone} 只` : '',
    s.groupCounts?.hold ? `➖ 持有观察 ${s.groupCounts.hold} 只` : '',
  ].filter(Boolean).join('；');

  const overviewRows = named.map((r) => {
    const weight = totalAssetsC > 0 ? ((r.marketValue / totalAssetsC) * 100).toFixed(1) + '%' : '—';
    return `<tr>
      <td><b>${esc(r.name)}</b><br><span class="code">${esc(r.code)}${r.isEtf ? ' · ETF' : ''}</span></td>
      <td class="num">${r.shares}</td>
      <td class="num">${yuan(r.avgCost)}</td>
      <td class="num ${pctClass(r.changePct)}">${pr(r.priceMilli)}</td>
      <td class="num ${pctClass(r.changePct)}">${pctText(r.changePct)}</td>
      <td class="num">${yuan(r.marketValue)}</td>
      <td class="num">${weight}</td>
      <td class="num">${r.stop ? pr(r.stop) : '—'}</td>
      <td class="num">${r.target ? pr(r.target) : '—'}</td>
      <td class="num ${pctClass(r.floatPnl)}">${yuan(r.floatPnl)}<br><span class="note-small">(${pctText(r.floatPnlPct)})</span></td>
      <td><span class="trig ${r.group}">${esc(r.badge)}</span></td>
    </tr>`;
  }).join('');

  const groupHtml = a.groups.map((g) => {
    const meta = GROUP_META[g.group];
    return `<div class="group-h ${meta.cls}">${meta.title}（${g.rows.length} 只）</div>${g.rows.map((r) => stockCard(r, totalAssetsC)).join('')}`;
  }).join('');

  // ── 市场环境 ────────────────────────────────────────────────────────────
  const idxCards = market?.indices?.length
    ? market.indices.map((x) => `<div class="idx">
        <div class="idx-name">${esc(x.name)}<span class="code"> ${esc(x.code)}</span></div>
        <div class="idx-val ${pctClass(x.changePct)}">${x.last === null ? '—' : Number(x.last).toFixed(2)}</div>
        <div class="idx-chg ${pctClass(x.changePct)}">${x.change === null ? '—' : (x.change > 0 ? '+' : '') + Number(x.change).toFixed(2)}（${pctText(x.changePct)}）</div>
        ${x.turnover ? `<div class="idx-vol">成交 ${yuan(x.turnover)}</div>` : ''}
      </div>`).join('')
    : '<div class="empty">指数行情未取到</div>';

  const breadth = market?.breadth;
  const ladder = market?.ladder;
  const mb = market?.marketBreadth;

  // 全市场涨跌体感分布条
  let marketBreadthBarHtml = '';
  if (mb && mb.total > 0) {
    const upPct = ((mb.up / mb.total) * 100).toFixed(1);
    const downPct = ((mb.down / mb.total) * 100).toFixed(1);
    const flatPct = ((mb.flat / mb.total) * 100).toFixed(1);
    const ratio = mb.down > 0 ? (mb.up / mb.down).toFixed(2) : '—';
    marketBreadthBarHtml = `
    <div class="breadth-box">
      <div class="breadth-head">
        <span class="breadth-title">全市场赚钱效应（共 ${mb.total} 只股票）</span>
        <span class="breadth-ratio">涨跌比 <b>${ratio} : 1</b></span>
      </div>
      <div class="breadth-bar">
        <div class="bar-seg seg-up" style="width:${upPct}%" title="上涨 ${mb.up} 只 (${upPct}%)"></div>
        <div class="bar-seg seg-flat" style="width:${flatPct}%" title="平盘 ${mb.flat} 只 (${flatPct}%)"></div>
        <div class="bar-seg seg-down" style="width:${downPct}%" title="下跌 ${mb.down} 只 (${downPct}%)"></div>
      </div>
      <div class="breadth-legend">
        <span class="up">▲ 上涨 ${mb.up} 只（${upPct}%）</span>
        <span class="flat">■ 平盘 ${mb.flat} 只（${flatPct}%）</span>
        <span class="down">▼ 下跌 ${mb.down} 只（${downPct}%）</span>
      </div>
    </div>`;
  }

  const sentimentPills = breadth
    ? `<div class="sent">
        <span class="pill buy">涨停 ${breadth.limitUp}</span>
        <span class="pill watch">跌停 ${breadth.limitDown}</span>
        <span class="pill info">炸板 ${breadth.limitBreak}</span>
        <span class="pill hold">封板率 ${breadth.sealRate === null ? '—' : breadth.sealRate + '%'}</span>
        ${ladder && ladder.maxBoard ? `<span class="pill info">最高 ${ladder.maxBoard} 板${ladder.maxBoardNames?.length ? '（' + esc(ladder.maxBoardNames.join('、')) + '）' : ''}</span>` : ''}
        ${market?.sectors?.flatLine ? `<span class="pill info">概念涨 ${market.sectors.flatLine.up} / 跌 ${market.sectors.flatLine.down}</span>` : ''}
      </div>`
    : '<div class="empty">涨跌停情绪未取到</div>';

  const sectorTable = market?.sectors?.gainers?.length
    ? `<table>
        <tr><th>领涨概念</th><th style="text-align:right">涨幅</th><th>领跌概念</th><th style="text-align:right">跌幅</th></tr>
        ${market.sectors.gainers.map((g, i) => {
          const l = market.sectors.losers?.[i] || {};
          return `<tr><td>${esc(g.name)}</td><td class="num up">${pctText(g.changePct)}</td><td>${esc(l.name || '')}</td><td class="num down">${l.changePct === undefined ? '' : pctText(l.changePct)}</td></tr>`;
        }).join('')}
      </table>`
    : '<div class="empty">板块行情未取到</div>';

  const tradeRows = (a.trades ?? []).map((t) => `<tr>
      <td>${esc(t.time || '')}</td>
      <td><b>${esc(t.name)}</b><br><span class="code">${esc(t.code)}</span></td>
      <td><span class="tag ${t.type === 'buy' ? 'buy' : 'sell'}">${t.type === 'buy' ? '买入' : '卖出'}</span></td>
      <td class="num">${t.shares}</td>
      <td class="num">${formatMilli(t.price * 10, 2)}</td>
      <td class="num">${yuan(t.amount)}</td>
      <td class="num">${yuan(t.fee)}</td>
      <td class="num ${pctClass(t.realizedPnl)}">${t.realizedPnl === null ? '—' : yuan(t.realizedPnl)}</td>
      <td class="note-small">${esc(t.psych || t.note || '')}</td>
    </tr>`).join('');

  const eventRows = events.length
    ? events.map((e) => `<tr><td>${esc(e.date || '')}</td><td><b>${esc(e.title || '')}</b></td><td>${esc(e.impact || '')}</td><td class="note-small">${esc(e.source || '')}</td></tr>`).join('')
    : `<tr><td colspan="4" class="empty">未提供。复盘时可用 web 搜索补齐（宏观数据发布、解禁、会议、财报窗口等），并在「来源」列标注链接——本页不编造事件。</td></tr>`;

  // 国债逆回购明细卡片
  const repoList = s.repos || [];
  const repoHtml = repoList.length
    ? `<div class="sub-card">
        <div class="sub-head"><b>当前持仓逆回购明细 (${repoList.length} 笔)</b></div>
        <table>
          <tr><th>代码</th><th>融出金额</th><th>年化利率</th><th>期限</th><th>成交日</th><th>到期日</th><th>预期收益</th></tr>
          ${repoList.map((rp) => `<tr>
            <td>${esc(rp.code || '204001')}</td>
            <td class="num"><b>${yuan(rp.amountC)}</b></td>
            <td class="num">${rp.rate}%</td>
            <td class="num">${rp.days}天</td>
            <td>${esc(rp.date)}</td>
            <td>${esc(rp.dueDate || '—')}</td>
            <td class="num up">+${yuan(rp.interestC)}</td>
          </tr>`).join('')}
        </table>
      </div>`
    : '';

  const rangeRows = named.filter((r) => r.stop && r.target && r.target > r.stop);
  const chartData = {
    totalAssets: Math.round(totalAssetsC / 100),
    assetPie: [
      { name: `股票持仓 (${stockRatioPct}%)`, value: Math.round(marketValueC / 100), itemStyle: { color: C_BLUE } },
      { name: `国债逆回购 (${repoRatioPct}%)`, value: Math.round(repoPrincipalC / 100), itemStyle: { color: C_REPO } },
      { name: `可用现金 (${cashRatioPct}%)`, value: Math.round(cashC / 100), itemStyle: { color: C_CASH } },
    ].filter((x) => x.value > 0),
    stockCount: named.length,
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

  const h = (n) => Math.max(160, n * 48 + 60);
  const marketErrors = (p.options?.marketErrors ?? market?.errors ?? []);
  const dataDay = market?.tradeDate || d;
  const dayNote = dataDay !== d ? `（${d} 非交易日，行情取最近交易日 ${dataDay} 收盘）` : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>持仓分析报告 · ${esc(d)}</title>
${echartsTag()}
<style>
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6f8;color:#292d35;max-width:980px;margin:0 auto;padding:0 20px 60px;line-height:1.55}

  /* 吸顶导航栏 */
  .sticky-nav{position:sticky;top:0;z-index:999;background:rgba(255,255,255,0.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid #e5e7eb;display:flex;justify-content:space-between;align-items:center;padding:12px 20px;margin:0 -20px 20px -20px;box-shadow:0 1px 4px rgba(0,0,0,0.03)}
  .nav-brand{font-weight:700;font-size:15px;color:#111827;display:flex;align-items:center;gap:6px}
  .nav-links{display:flex;gap:12px}
  .nav-links a{text-decoration:none;color:#4b5563;font-size:13px;font-weight:500;padding:4px 8px;border-radius:6px;transition:all .15s}
  .nav-links a:hover{color:#2f6fed;background:#f0f4ff}

  h1{font-size:24px;margin:8px 0 6px;letter-spacing:.2px;font-weight:700;color:#111827}
  h2{font-size:18px;margin:32px 0 12px;font-weight:700;color:#1f2937;display:flex;align-items:center;gap:8px}
  h2::before{content:"";display:inline-block;width:4px;height:18px;background:#2f6fed;border-radius:2px}
  .sub{color:#6b7280;font-size:13.5px;margin-bottom:10px}
  .meta{font-size:12.5px;color:#6b7280;background:#eef1f4;border-radius:8px;padding:8px 12px;margin-bottom:16px}

  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:18px;margin:14px 0;box-shadow:0 1px 3px rgba(0,0,0,.03)}
  .sub-card{background:#fafbfc;border:1px solid #edf0f3;border-radius:8px;padding:12px;margin-top:14px}
  .sub-head{font-size:13px;color:#4b5563;margin-bottom:8px}

  /* KPI 看板 */
  .kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:12px 0}
  .kpi-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:12px 14px;box-shadow:0 1px 3px rgba(0,0,0,.02)}
  .kpi-label{font-size:12.5px;color:#6b7280;margin-bottom:4px}
  .kpi-val{font-size:21px;font-weight:700;color:#111827;font-variant-numeric:tabular-nums;line-height:1.2}
  .kpi-sub{font-size:11.5px;color:#8b93a1;margin-top:4px}

  .tldr{background:#fffaf3;border-color:#f5e3cb}
  .tldr h3{margin:0 0 6px;font-size:15px;color:#92400e}
  .tldr p{margin:0 0 10px;font-size:13.5px;color:#451a03;line-height:1.6}

  .pill{display:inline-block;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;margin:2px 6px 2px 0}
  .pill.buy{background:#fde8e8;color:${C_UP}}
  .pill.hold{background:#fff3df;color:${C_GOLD}}
  .pill.watch{background:#e8f5ee;color:${C_DOWN}}
  .pill.info{background:#eaf0ff;color:${C_BLUE}}
  .pill.repo{background:#f3e8ff;color:${C_REPO}}

  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{border-bottom:1px solid ${C_LINE};padding:10px 8px;text-align:left;vertical-align:top}
  th{color:#6b7280;font-weight:600;background:#fafbfc}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .up{color:${C_UP};font-weight:600}.down{color:${C_DOWN};font-weight:600}.flat{color:#8b93a1}
  .code{color:#6b7280;font-size:12px}

  /* 分组色带与持仓卡片 */
  .group-h{padding:8px 12px;border-radius:8px;font-weight:700;margin:20px 0 8px;font-size:14px}
  .g-buy{background:#fde8e8;color:${C_UP}}
  .g-hold{background:#fff3df;color:${C_GOLD}}
  .g-stop{background:#e8f5ee;color:${C_DOWN}}
  .g-watch{background:#eef1f4;color:${C_INK}}

  .stock{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin:10px 0}
  .head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-weight:700;font-size:14px}
  .dir{font-size:12px;color:#6b7280;background:#f3f4f6;padding:2px 8px;border-radius:6px;font-weight:400}
  .weight{font-size:12px;color:#2f6fed;background:#eef4ff;padding:2px 8px;border-radius:6px;font-weight:600}
  .trig{font-size:12px;padding:2px 8px;border-radius:6px;font-weight:600;background:#f3f4f6;color:${C_INK}}
  .trig.stop{background:#e8f5ee;color:${C_DOWN}}
  .trig.target{background:#fff3df;color:${C_GOLD}}
  .trig.zone{background:#fde8e8;color:${C_UP}}
  .datarow{font-size:13px;color:${C_INK};margin:8px 0}
  .note{font-size:12px;color:#6b7280;margin:6px 0}
  .note-small{font-size:11.5px;color:#8b93a1}
  .op{font-size:13px;background:#f8fafc;padding:9px 12px;border-radius:8px;border-left:3px solid #2f6fed;margin-top:8px}

  /* 计划区间进度条 (Mini Range Bar) */
  .range-box{background:#f9fafb;border:1px solid #f0f2f5;border-radius:8px;padding:10px 12px;margin:10px 0}
  .range-labels{display:flex;justify-content:space-between;font-size:11.5px;color:#6b7280;margin-bottom:6px}
  .range-curr{font-weight:700;color:#1f2937}
  .range-track{position:relative;height:12px;background:#e5e7eb;border-radius:6px;overflow:visible;margin:14px 0 16px}
  .range-fill{position:absolute;top:0;left:0;height:100%;border-radius:6px}
  .range-fill.in-range{background:linear-gradient(90deg,#93c5fd,#3b82f6)}
  .range-fill.target{background:linear-gradient(90deg,#fcd34d,#f59e0b)}
  .range-fill.stop{background:linear-gradient(90deg,#86efac,#10b981)}
  .range-pin{position:absolute;top:-6px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center}
  .range-pin.price span{background:#111827;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:600;white-space:nowrap}
  .range-pin.cost span{background:#d97706;color:#fff;font-size:10px;padding:1px 5px;border-radius:4px;font-weight:600;white-space:nowrap}
  .range-sub{display:flex;justify-content:space-between;font-size:11.5px;color:#6b7280}

  /* 全市场体感分布条 */
  .breadth-box{background:#fafbfc;border:1px solid #e5e7eb;border-radius:10px;padding:14px;margin-bottom:14px}
  .breadth-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
  .breadth-title{font-size:13.5px;font-weight:700;color:#374151}
  .breadth-ratio{font-size:12.5px;color:#6b7280}
  .breadth-ratio b{color:#111827}
  .breadth-bar{display:flex;height:14px;border-radius:7px;overflow:hidden;background:#e5e7eb}
  .bar-seg{height:100%;transition:width .3s}
  .seg-up{background:${C_UP}}
  .seg-flat{background:#9ca3af}
  .seg-down{background:${C_DOWN}}
  .breadth-legend{display:flex;justify-content:space-around;font-size:12px;margin-top:8px}

  .chart{width:100%}
  .empty{color:#9aa0a6;font-size:13px;padding:8px 0}
  .idxs{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
  .idx{background:#fafbfc;border:1px solid ${C_LINE};border-radius:8px;padding:10px 12px}
  .idx-name{font-size:12.5px;color:#6b7280}
  .idx-val{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;margin:2px 0}
  .idx-chg{font-size:12.5px}
  .idx-vol{font-size:11.5px;color:#8b93a1;margin-top:2px}
  .sent{margin:4px 0 12px}
  .tag{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:6px}
  .tag.buy{background:#fde8e8;color:${C_UP}}
  .tag.sell{background:#e8f5ee;color:${C_DOWN}}
  .chart-title{font-size:14.5px;color:${C_INK};margin:20px 0 6px;font-weight:600}
  .foot{font-size:12px;color:#9aa0a6;margin-top:36px;border-top:1px solid ${C_LINE};padding-top:14px}
  .foot b{color:#6b7280}

  @media(max-width:768px){
    .kpi-grid{grid-template-columns:repeat(2,1fr)}
    .idxs{grid-template-columns:1fr}
    .sticky-nav{flex-direction:column;gap:8px;padding:8px 12px}
  }
</style>
</head>
<body>

<nav class="sticky-nav">
  <div class="nav-brand">📊 持仓分析 · ${esc(d)}</div>
  <div class="nav-links">
    <a href="#sec-asset">💎 全资产配置</a>
    <a href="#sec-market">🌐 大盘与情绪</a>
    <a href="#sec-holdings">🎯 持仓分析</a>
    <a href="#sec-trades">📝 今日流水</a>
    <a href="#sec-events">📅 风险日历</a>
  </div>
</nav>

<h1>持仓分析报告 · ${esc(d)}</h1>
<div class="sub">底账真实资产架构 → 今日大盘与情绪广度 → 计划对照与持仓操作取向</div>
<div class="meta">行情截至 ${esc(dataDay)}${dayNote} ｜ 账户 ${esc(a.account || '默认')} ｜ 数据来源 同花顺金融数据API（fuyao.aicubes.cn） ｜ 持仓行情口径 ${a.rows.some((r) => r.dataSource === '实时快照') ? '实时快照' : '最近交易日日线'}${market?.indexDate ? ` ｜ 指数 ${esc(market.indexDate)}` : ''}${market?.breadth?.date ? ` ｜ 涨跌停 ${esc(market.breadth.date)}` : ''} ｜ 生成时间 ${esc(p.options?.generatedAt || a.generatedAt || '')}</div>

<div class="card tldr">
  <h3>⚡ 一句话结论与资产全景</h3>
  <p>${esc(tldr)}</p>
  <span class="pill info">总资产 ${yuan(totalAssetsC)}</span>
  <span class="pill info">股票市值 ${yuan(marketValueC)} (${stockRatioPct}%)</span>
  <span class="pill repo">逆回购 ${yuan(repoPrincipalC)} (${repoRatioPct}%)</span>
  <span class="pill info">现金 ${yuan(cashC)} (${cashRatioPct}%)</span>
  <span class="pill ${s.floatPnlC >= 0 ? 'buy' : 'watch'}">股票浮动盈亏 ${yuan(s.floatPnlC)}（${pctText(s.floatPnlPct)}）</span>
  ${s.tradeCount ? `<span class="pill info">今日交易 ${s.tradeCount} 笔</span>` : ''}
</div>

<h2 id="sec-asset">一、全资产总览与仓位配置</h2>
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">💎 总资产</div>
    <div class="kpi-val">${yuan(totalAssetsC)}</div>
    <div class="kpi-sub">基准初始本金 ${yuan(s.initialCapital || totalAssetsC)}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">📈 股票市值</div>
    <div class="kpi-val">${yuan(marketValueC)}</div>
    <div class="kpi-sub">真实仓位 <b>${stockRatioPct}%</b> ｜ ${s.count} 只标的</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">🔄 国债逆回购</div>
    <div class="kpi-val">${yuan(repoPrincipalC)}</div>
    <div class="kpi-sub">资产占比 <b>${repoRatioPct}%</b> ｜ ${s.repoCount || 0} 笔进行中</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">💰 可用资金</div>
    <div class="kpi-val">${yuan(cashC)}</div>
    <div class="kpi-sub">资金占比 <b>${cashRatioPct}%</b></div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">📊 股票浮动盈亏</div>
    <div class="kpi-val ${pctClass(s.floatPnlC)}">${yuan(s.floatPnlC)}</div>
    <div class="kpi-sub ${pctClass(s.floatPnlPct)}">收益率 <b>${pctText(s.floatPnlPct)}</b></div>
  </div>
</div>

<div class="card">
  <h3 class="chart-title" style="margin-top:0">全资产配置大盘图（股票 vs 逆回购 vs 现金）</h3>
  <div id="assetPieChart" class="chart" style="height:260px"></div>
  ${repoHtml}
</div>

<h2 id="sec-market">二、今日大盘与市场情绪</h2>
<div class="card">
  <div class="idxs">${idxCards}</div>
  ${marketBreadthBarHtml}
  ${sentimentPills}
  <div id="idxChart" class="chart" style="height:${Math.max(140, (market?.indices?.length || 0) * 40 + 50)}px"></div>
  ${marketErrors.length ? `<div class="empty">⚠ 部分数据未取到：${esc(marketErrors.join('；'))}</div>` : ''}
</div>

<div class="card">
  <h3 class="chart-title" style="margin-top:0">板块表现${market?.sectors?.total ? `（概念 ${market.sectors.total} 个）` : ''}</h3>
  ${sectorTable}
  ${market?.sectors?.gainers?.length ? '<div id="secChart" class="chart" style="height:' + h(market.sectors.gainers.length + market.sectors.losers.length) + 'px"></div>' : ''}
</div>

<h2 id="sec-holdings">三、持仓逐只深度分析（${named.length} 只）</h2>
<div class="card">
  <table>
    <tr>
      <th>标的名称/代码</th>
      <th style="text-align:right">持仓股数</th>
      <th style="text-align:right">持仓成本</th>
      <th style="text-align:right">最新现价</th>
      <th style="text-align:right">当日涨跌</th>
      <th style="text-align:right">持仓市值</th>
      <th style="text-align:right">占总资产</th>
      <th style="text-align:right">止损位</th>
      <th style="text-align:right">目标位</th>
      <th style="text-align:right">浮动盈亏</th>
      <th>触发状态</th>
    </tr>
    ${overviewRows || '<tr><td colspan="11" class="empty">（台账无持仓）</td></tr>'}
  </table>
</div>

${named.length > 3 ? `
<h3 class="chart-title">浮动盈亏率对比（%）</h3>
<div class="card"><div id="pnlChart" class="chart" style="height:${h(named.length)}px"></div></div>

<h3 class="chart-title">当日涨跌幅对比（%）</h3>
<div class="card"><div id="chgChart" class="chart" style="height:${h(named.length)}px"></div></div>

<h3 class="chart-title">股票池持仓市值分布</h3>
<div class="card"><div id="mvChart" class="chart" style="height:${Math.max(260, named.length * 26 + 180)}px"></div></div>

${rangeRows.length ? `<h3 class="chart-title">计划区间位置（止损 = 0% → 目标 = 100%）</h3>
<div class="card"><div id="rangeChart" class="chart" style="height:${h(rangeRows.length)}px"></div></div>` : ''}
` : ''}

${groupHtml || '<div class="card empty">（台账无持仓）</div>'}

<h2 id="sec-trades">四、今日交易流水${s.tradeCount ? `（${s.tradeCount} 笔）` : ''}</h2>
<div class="card">
  ${s.tradeCount
    ? `<table>
        <tr><th>时间</th><th>标的</th><th>方向</th><th style="text-align:right">股数</th><th style="text-align:right">成交价</th><th style="text-align:right">金额</th><th style="text-align:right">手续费</th><th style="text-align:right">已实现盈亏</th><th>交易心理/备注</th></tr>
        ${tradeRows}
      </table>
      <div class="note" style="margin-top:10px">当日合计：手续费 ${yuan(s.dayFeesC)} ｜ 已实现盈亏 ${yuan(s.dayRealizedC)}</div>`
    : '<div class="empty">今日无交易流水（台账里没有当日买卖记录）</div>'}
</div>

<h2 id="sec-events">五、风险日历（未来 3–5 日）</h2>
<div class="card">
  <table>
    <tr><th>日期</th><th>事件</th><th>可能影响</th><th>来源</th></tr>
    ${eventRows}
  </table>
</div>

<div class="foot">
  <p><b>分析说明：</b>本页为台账持仓（${esc(a.account || '默认账户')}）的计划对照分析。全资产统计包含股票市值、国债逆回购与可用资金；止损/目标/买入区沿用台账记录，不做改动；行情、指数、板块与涨跌停数据来自同花顺金融数据 API，逐只判定规则为「当日最低价 ≤ 买入区上沿 且 收盘 ≥ 止损 → 可低吸；触/逼目标 → 止盈；破位/逼近止损 → 止损预警」。持仓卡片中的「建仓 / 最近一笔」用于区分<b>存量持仓</b>与<b>今日交易</b>。</p>
  <p><b>风险提示：</b>本页仅基于公开市场数据与用户自记台账做客观标注，不含主观操盘指引，不构成投资建议或证券投资咨询服务；市场有风险，决策需谨慎，请以交易所官方数据为准。</p>
</div>

<script>
var DATA = ${JSON.stringify(chartData)};
var UP = '${C_UP}', DOWN = '${C_DOWN}', GOLD = '${C_GOLD}', BLUE = '${C_BLUE}', INK = '${C_INK}', LINE = '${C_LINE}';
var AXIS = {axisLine:{lineStyle:{color:'#e5e7eb'}},axisLabel:{color:INK,fontSize:11.5},axisTick:{show:false}};
var charts = [];

function init(id, option){
  var el = document.getElementById(id);
  if(!el || typeof echarts === 'undefined') return null;
  var c = echarts.init(el);
  c.setOption(option);
  charts.push(c);
  return c;
}

// 1. 全资产配置分布环形图
if (DATA.assetPie && DATA.assetPie.length) {
  init('assetPieChart', {
    tooltip:{trigger:'item',valueFormatter:function(v){return v.toLocaleString()+' 元';}},
    legend:{bottom:10,itemWidth:14,itemHeight:14,textStyle:{color:INK,fontSize:12.5}},
    series:[{
      type:'pie',
      radius:['46%','72%'],
      center:['50%','44%'],
      itemStyle:{borderColor:'#fff',borderWidth:3},
      data:DATA.assetPie,
      label:{color:INK,fontSize:12,formatter:'{b}\\n¥{c} 元'},
      labelLine:{lineStyle:{color:'#cbd5e1'}}
    }]
  });
}

// 2. 指数涨跌
if (DATA.idxNames.length){
  init('idxChart', {
    grid:{left:8,right:56,top:12,bottom:8,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:function(v){return v+'%';}},
    xAxis:Object.assign({type:'value',axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e5e7eb'}},axisTick:{show:false}}),
    yAxis:Object.assign({type:'category',data:DATA.idxNames,inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:20,
      data:DATA.idxPct.map(function(v){return {value:v,itemStyle:{color:v>=0?UP:DOWN,borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}};}),
      label:{show:true,position:'right',formatter:function(p){return p.value+'%';},fontSize:11.5,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#d7dbe0',type:'dashed'},data:[{xAxis:0}]}
    }]
  });
}

// 3. 板块涨跌
if (DATA.secUpNames.length || DATA.secDownNames.length){
  var secNames = DATA.secUpNames.concat(DATA.secDownNames);
  var secVals = DATA.secUpPct.concat(DATA.secDownPct);
  init('secChart', {
    grid:{left:8,right:56,top:12,bottom:8,containLabel:true},
    tooltip:{trigger:'axis',axisPointer:{type:'shadow'},valueFormatter:function(v){return v+'%';}},
    xAxis:Object.assign({type:'value',axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e5e7eb'}},axisTick:{show:false}}),
    yAxis:Object.assign({type:'category',data:secNames,inverse:true}, AXIS),
    series:[{
      type:'bar', barMaxWidth:18,
      data:secVals.map(function(v){return {value:v,itemStyle:{color:v>=0?UP:DOWN,borderRadius:v>=0?[0,4,4,0]:[4,0,0,4]}};}),
      label:{show:true,position:'right',formatter:function(p){return p.value+'%';},fontSize:11,color:INK},
      markLine:{silent:true,symbol:'none',lineStyle:{color:'#d7dbe0',type:'dashed'},data:[{xAxis:0}]}
    }]
  });
}

// 4. 多只股票时的对比图表 (stockCount > 3)
if (DATA.stockCount > 3) {
  function barOption(values, unit){
    return {
      grid:{left:8,right:52,top:12,bottom:6,containLabel:true},
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
    tooltip:{trigger:'item',valueFormatter:function(v){return v+' 元';}},
    legend:{bottom:0,itemWidth:12,itemHeight:12,textStyle:{color:INK,fontSize:12}},
    series:[{
      type:'pie', radius:['42%','66%'], center:['50%','44%'],
      itemStyle:{borderColor:'#fff',borderWidth:2},
      data:DATA.names.map(function(n,i){return {name:n,value:DATA.marketValue[i]};}),
      label:{color:INK,fontSize:11.5,formatter:'{b}\\n{d}%'},
      labelLine:{lineStyle:{color:'#c9ced6'}}
    }]
  });
  if (DATA.rangePos.length){
    init('rangeChart', {
      grid:{left:8,right:56,top:22,bottom:6,containLabel:true},
      tooltip:{trigger:'axis',axisPointer:{type:'shadow'},formatter:function(ps){
        var d = DATA.rangePos[ps[0].dataIndex];
        var y = function(m){ return (m%10===0) ? (m/1000).toFixed(2) : (m/1000).toFixed(3); };
        return d.name+'<br>止损 ¥'+y(d.stop)+' → 目标 ¥'+y(d.target)+'<br>现价 ¥'+y(d.price)+'<br>区间位置 '+d.pos+'%';
      }},
      xAxis:Object.assign({type:'value',min:0,max:Math.max(100, Math.ceil(Math.max.apply(null, DATA.rangePos.map(function(x){return x.pos;})) / 10) * 10),axisLabel:{formatter:'{value}%',color:INK,fontSize:11.5},splitLine:{lineStyle:{color:LINE}}}, {axisLine:{lineStyle:{color:'#e5e7eb'}},axisTick:{show:false}}),
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
}

window.addEventListener('resize', function(){ charts.forEach(function(c){ c && c.resize(); }); });
</script>
</body>
</html>
`;
}
