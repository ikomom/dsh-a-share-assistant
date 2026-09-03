#!/usr/bin/env node
// A股助手 CLI：环境自检 + 配置管理 + 缓存管理 + 取数
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ping, dataLinkProbe, getData, ENDPOINTS, ERROR_CODE_HINTS } from './fuyao.js';
import * as cache from './cache.js';
import * as position from './position.js';
import { formatYuan, toCents } from './money.js';
import { CACHE_ROOT, PROJECT_ROOT, NOTES_ROOT, getApiKey, getConfigSource, USER_CONFIG_PATH, homeDir, isConfigPresent } from './config.js';

/** 插件版本（check 输出；会话中若代码被更新，可据此识别新旧） */
export const CLI_VERSION = '0.1.2';

function log(msg) {
  console.log(msg);
}

function fail(msg) {
  console.error(`错误: ${msg}`);
  process.exit(1);
}

async function cmdCheck(opts = {}) {
  log('== A股助手数据链路体检 ==');
  log(`Node: ${process.version}`);
  log(`CLI 版本: ${CLI_VERSION}`);
  log(`项目: ${PROJECT_ROOT}`);
  // 源码最后修改时间：与会话开始时间对比，可识别"运行中代码被更新"
  const srcMtimes = [];
  for (const f of ['cli.js', 'config.js', 'cache.js', 'fuyao.js']) {
    try { srcMtimes.push(fs.statSync(path.join(PROJECT_ROOT, 'src', f)).mtime.toISOString().slice(0, 19).replace('T', ' ')); } catch {}
  }
  log(`源码更新于: ${srcMtimes.join(' / ') || '未知'}`);
  log(`笔记库根: ${NOTES_ROOT || '未配置（参照提醒关闭）'}`);
  log(`配置来源: ${getConfigSource()}`);
  if (!isConfigPresent()) {
    log('⚠️ [CONFIG_MISSING] 未检测到用户配置文件，如需创建请运行: node src/cli.js config（交互询问）或 config --init / config --template');
  }
  log(`缓存目录: ${CACHE_ROOT} (存在: ${fs.existsSync(CACHE_ROOT)})`);
  log('-- 网络连通性 --');
  try {
    const p = await ping();
    log(`fuyao.aicubes.cn -> HTTP ${p.status} (${p.ms}ms) ${p.ok ? '✅ 可用' : '⚠️ 异常'}`);
  } catch (e) {
    log(`fuyao.aicubes.cn -> ❌ ${e.message}`);
    if (process.platform === 'win32') {
      log('提示: Windows 下 PowerShell/curl 常因 schannel 无法建立 TLS，取数务必走 CLI（内部 node fetch）。');
    } else {
      log('提示: 请确认网络可达 fuyao.aicubes.cn（取数走 CLI 内部 node fetch）。');
    }
  }
  log('-- 数据链路 --');
  const dl = await dataLinkProbe();
  const keyState = !dl.keyOk
    ? '❌ 未配置（请在会话目录 .a-share-assistant/config.json 的 fuyao.apiKey 或环境变量 FUYAO_API_KEY 中填写，官网 https://fuyao.aicubes.cn 签发）'
    : `✅ 已配置（来源: ${dl.apiKeySource}）`;
  log(`API Key: ${keyState}`);
  log(
    dl.endpointsCount > 0
      ? `端点映射: ✅ 已配置 ${dl.endpointsCount} 项`
      : '端点映射: ❌ 为空（v0.2 待办，当前无法取真实数据）'
  );
  log(`试调: ${dl.probe.detail}`);
  const ready = dl.keyOk && dl.endpointsCount > 0 && dl.probe.ok;
  log(ready ? '→ 数据链路就绪，可以取数' : '→ 数据链路未就绪：请先补 key / 端点映射后再取数，不要现场翻源码找接口');
  if (opts.quick) return; // --quick：只看链路就绪，跳过缓存索引与参数速查
  log('-- 缓存索引 --');
  const st = cache.status();
  log(`磁盘占用: ${st.sizeHuman}`);
  if (st.rows.length === 0) log('（暂无缓存数据，先跑 snapshot）');
  for (const r of st.rows.slice(0, 15)) {
    log(`  ${r.label.padEnd(10)} 最新=${r.latest} 拉取=${r.fetchedAt} ${r.state}`);
  }
  if (st.rows.length > 15) log(`  … 其余 ${st.rows.length - 15} 条（cache status 查看全部）`);
  log('-- 常用端点参数速查 --');
  log('  行情/估值/异动: --thscodes 600396.SH,001258.SZ（复数，逗号分隔；price-snapshot 缺它=全市场）');
  log('  财务三表:       --thscode X --period annual|quarterly --limit N');
  log('  财务指标:       --thscode X --report YYYY-N（与三表报告期对齐）');
  log('  K线/指数:       --thscode X --start YYYY-MM-DD --end YYYY-MM-DD（自动转毫秒）');
  log('  龙虎榜:         --board-type all|org|hot_money --date YYYY-MM-DD');
  log('  板块:           --tag cn_concept|industry');
  log('提示: 端点详细参数用 `node src/cli.js data --kind <端点> --help` 查询');
}

function cmdCache(argv) {
  const sub = argv._[0];
  const opts = argv.values;
  switch (sub) {
    case 'status':
      return cmdCacheStatus();
    case 'snapshot':
      return cmdCacheSnapshot(opts);
    case 'latest':
      return cmdCacheLatest(opts);
    case 'get':
      return cmdCacheGet(opts);
    case 'clean':
      return cmdCacheClean(opts);
    default:
      fail(
        `未知子命令 "${sub}"。支持: status | snapshot --type X [--date D] [--file F|--data J] | latest --type X | get --type X --date D | clean [--keep-days N]`
      );
  }
}

function cmdCacheStatus() {
  const st = cache.status();
  log(`缓存目录: ${st.cacheRoot}`);
  log(`磁盘占用: ${st.sizeHuman}`);
  for (const r of st.rows) {
    log(`  ${r.key.padEnd(22)} 最新=${r.latest} 拉取=${r.fetchedAt} ${r.state}`);
  }
}

function cmdCacheSnapshot(opts) {
  const type = opts.type;
  if (!type) fail('snapshot 需要 --type (limit-up|dragon-tiger|sectors|watchlist|news|announcements|个股用 --code)');
  let data;
  if (opts.file) {
    data = JSON.parse(fs.readFileSync(opts.file, 'utf8'));
  } else if (opts.data) {
    data = JSON.parse(opts.data);
  } else {
    fail('snapshot 需要 --file <json文件> 或 --data <json字符串>');
  }
  if (opts.code) {
    const file = cache.saveStock({ code: opts.code, type, data });
    log(`已保存个股缓存: ${file}`);
    return;
  }
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const file = cache.saveSnapshot({ type, date, data });
  log(`已保存快照: ${file}`);
}

function cmdCacheLatest(opts) {
  const type = opts.type;
  if (!type) fail('latest 需要 --type');
  if (opts.code) {
    const r = cache.stockLatest(opts.code, type);
    if (!r.hit) {
      log(`MISS 个股无缓存: stocks/${cache.safeFilePart(opts.code)}/${cache.safeFilePart(type)}.json`);
      process.exitCode = 1;
      return;
    }
    log(`HIT 个股 ${opts.code}/${type} ${r.expired ? '[已过期]' : '[有效]'} 文件=${r.file}`);
    console.log(JSON.stringify(r.data, null, 2));
    return;
  }
  const r = cache.latest(type);
  if (!r.hit) {
    log(`MISS 无缓存或已过期，需要重新拉取数据并 snapshot。`);
    process.exitCode = 1;
    return;
  }
  log(`HIT ${type} (${r.date}) ${r.expired ? '[已过期]' : '[有效]'} 文件=${r.file}`);
  console.log(JSON.stringify(r.data, null, 2));
}

function cmdCacheGet(opts) {
  const { type, date } = opts;
  if (!type || !date) fail('get 需要 --type 与 --date');
  const r = cache.getByDate(type, date);
  if (!r.hit) {
    log(`MISS ${date}/${type} 无此快照。`);
    process.exitCode = 1;
    return;
  }
  log(`HIT ${type} (${r.date}) ${r.expired ? '[已过期]' : '[有效]'}`);
  console.log(JSON.stringify(r.data, null, 2));
}

function cmdCacheClean(opts) {
  const keepDays = opts['keep-days'] ? Number(opts['keep-days']) : 30;
  const r = cache.clean({ keepDays });
  log(`清理完成: 归档 ${r.archived.length} 个月 (${r.archived.join(', ') || '无'}), 删除 ${r.deleted.length} 项 (${r.deleted.join(', ') || '无'})`);
}

// ── 取数：node cli.js data --kind <端点> [参数] [--save <缓存类型> [--code X] --date D] ──
function toMsTimestamp(value) {
  // 接受 YYYY-MM-DD（Asia/Shanghai 当日零点）或已有毫秒戳
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return String(Date.parse(`${value}T00:00:00+08:00`));
  }
  return value;
}

async function cmdData(opts) {
  const kind = opts.kind;
  if (!kind) {
    fail(`data 需要 --kind。可用端点: ${Object.keys(ENDPOINTS).join(', ')}（或跑 help/--kind --help 看参数说明）`);
  }
  const spec = ENDPOINTS[kind];
  // --help：输出该端点的参数说明与示例（无需取数）
  if (opts.help) {
    log(`端点: ${kind}（${spec ? spec.note : '未配置'}）`);
    if (!spec) return;
    log(`路径: ${spec.path}`);
    const req = spec.params?.required ?? [];
    log(`必填参数: ${req.length ? req.join(', ') : '无'}`);
    if (spec.params?.warn) log(`注意: ${spec.params.warn}`);
    if (spec.params?.example) log(`示例: node src/cli.js ${spec.params.example}`);
    return;
  }
  const paramMap = {
    q: opts.q, thscodes: opts.thscodes, thscode: opts.thscode,
    limit: opts.limit, offset: opts.offset, interval: opts.interval,
    start: opts.start, end: opts.end, adjust: opts.adjust,
    from: opts.from, to: opts.to,
    period: opts.period, report: opts.report, tag: opts.tag,
    date: opts.date, 'date_ms': opts['date-ms'],
    board_type: opts['board-type'], page: opts.page, size: opts.size,
    sort_field: opts['sort-field'], sort_dir: opts['sort-dir'],
    stage: opts.stage, exchange: opts.exchange, asset_type: opts['asset-type'],
    tag_codes: opts['tag-codes'], start_date: opts['start-date'], end_date: opts['end-date'],
  };
  const params = {};
  for (const [k, v] of Object.entries(paramMap)) {
    if (v === undefined || v === null || v === '') continue;
    params[k] = (k === 'start' || k === 'end') ? toMsTimestamp(v) : v;
  }
  // 参数别名：thscode ↔ thscodes 按端点必填声明自动互填（消除复数陷阱）
  const required = spec?.params?.required ?? [];
  for (const field of required) {
    const alias = field === 'thscodes' ? 'thscode' : field === 'thscode' ? 'thscodes' : null;
    if (alias && (params[field] === undefined || params[field] === '') && params[alias]) {
      params[field] = params[alias];
    }
  }
  let result;
  try {
    result = await getData(kind, params);
  } catch (e) {
    fail(`取数失败: ${e.message}${spec ? `（端点 ${kind}: ${spec.note}）` : ''}`);
  }
  if (result && result.code !== undefined && result.code !== 0) {
    const hint = ERROR_CODE_HINTS[result.code];
    fail(`接口业务错误 code=${result.code} message=${result.message}${hint ? `；修复指引: ${hint}` : ''}${spec ? `（端点 ${kind}: ${spec.params?.example || ''}）` : ''}`);
  }
  if (opts.save) {
    if (opts.code) {
      const file = cache.saveStock({ code: opts.code, type: opts.save, data: result.data ?? result });
      log(`已取数并缓存(个股): ${file}`);
    } else {
      const date = opts.date || new Date().toISOString().slice(0, 10);
      const file = cache.saveSnapshot({ type: opts.save, date, data: result.data ?? result });
      log(`已取数并缓存: ${file}`);
    }
    return;
  }
  // 契约：data 默认 stdout 输出纯 JSON（可被 JSON.parse）。
  // 要省 token 用 --summary（人读摘要）或 --save（落盘不打印）。--full 兼容保留（=默认）。
  if (opts.summary) {
    printDataSummary(result);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

/** 取数结果的精简摘要：数组类只显示总数+前几条，避免大 JSON 灌入上下文 */
function printDataSummary(result) {
  const data = result?.data ?? result;
  let c = '';
  if (Array.isArray(data)) c = `（数组 ${data.length} 条）`;
  else if (data && Array.isArray(data.item)) c = `（共 ${data.total ?? data.item.length} 条）`;
  log(`取数摘要 ${c}（查看全部加 --full）`);
  const item = Array.isArray(data) ? data : data?.item;
  if (Array.isArray(item)) {
    const shown = item.slice(0, 5);
    for (const it of shown) log(`  ${JSON.stringify(it).slice(0, 240)}`);
    if (item.length > shown.length) log(`  … 其余 ${item.length - shown.length} 条 --full 查看`);
  } else {
    log(`  ${JSON.stringify(data).slice(0, 1000)}`);
  }
}

// ── 一键个股体检：node cli.js investigate --code X [--report YYYY-N] ──
async function cmdInvestigate(opts) {
  if (!opts.code) fail('investigate 需要 --code <代码，如 600519.SH>');
  const code = opts.code;
  // 一次拉齐个股体检常用数据并落盘（indicators 需报告期，另取）
  const jobs = [
    ['quote', 'price-snapshot', { thscodes: code }],
    ['income', 'income-statements', { thscode: code, period: 'quarterly', limit: 4 }],
    ['balance', 'balance-sheets', { thscode: code, period: 'quarterly', limit: 4 }],
    ['cashflow', 'cash-flow-statements', { thscode: code, period: 'quarterly', limit: 4 }],
    ['valuation', 'valuations-snapshot', { thscodes: code }],
    ['event', 'anomaly-analysis-stock', { thscodes: code }],
  ];
  if (opts.report) jobs.push(['indicators', 'financial-indicators', { thscode: code, report: opts.report }]);
  log(`一键体检 ${code}：`);
  const results = await Promise.all(jobs.map(async ([type, kind, params]) => {
    try {
      const r = await getData(kind, params);
      if (r && r.code !== undefined && r.code !== 0) throw new Error(`code=${r.code} ${r.message}`);
      const f = cache.saveStock({ code, type, data: r.data ?? r });
      return { type, ok: true, file: path.basename(f) };
    } catch (e) {
      return { type, ok: false, err: e.message };
    }
  }));
  for (const x of results) log(x.ok ? `  ✔ ${x.type.padEnd(10)} ${x.file}` : `  ✗ ${x.type.padEnd(10)} ${x.err}`);
  log(`  完成: ${results.filter((x) => x.ok).map((x) => x.type).join('、')}`);
  log(`  财务指标另取: data --kind financial-indicators --thscode ${code} --report YYYY-N（或用 --report 一并取）`);
}

// ── 一键每日复盘快照：node cli.js daily-snapshot [--date D] ──
async function cmdDailySnapshot(opts) {
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const idx = '000001.SH,399001.SZ,399006.SZ';
  const jobs = [
    ['limit-up', 'limit-up-pool', {}],
    ['limit-down', 'limit-down-pool', {}],
    ['limit-break', 'limit-break-pool', {}],
    ['ladder', 'limit-up-ladder', {}],
    ['dragon-tiger', 'dragon-tiger-list', {}],
    ['hot-stock', 'hot-stock-list', { period: 'day' }],
    ['sectors', 'ths-index-list', { tag: 'cn_concept' }],
    ['index', 'index-price-snapshot', { thscodes: idx }],
  ];
  log(`每日复盘快照 ${date}：`);
  const results = await Promise.all(jobs.map(async ([type, kind, params]) => {
    try {
      const r = await getData(kind, params);
      if (r && r.code !== undefined && r.code !== 0) throw new Error(`code=${r.code} ${r.message}`);
      const f = cache.saveSnapshot({ type, date, data: r.data ?? r });
      return { type, ok: true, file: path.basename(f) };
    } catch (e) {
      return { type, ok: false, err: e.message };
    }
  }));
  for (const x of results) log(x.ok ? `  ✔ ${x.type.padEnd(12)} ${x.file}` : `  ✗ ${x.type.padEnd(12)} ${x.err}`);
  log(`  完成: ${results.filter((x) => x.ok).map((x) => x.type).join('、')}`);
  log(`  复盘时用 cache latest --type <limit-up|dragon-tiger|sectors|hot-stock|index|...> 读取`);
}

// ── 交易台账：node cli.js position <init|add|buy|sell|list|summary|today|query> ──
// 多维度高级查询：--code 标的 / --from --to 区间 / --type buy|sell / --only profit|loss
//            --sort date|amount|pnl / --limit N / --group code|month
async function cmdPositionQuery(o) {
  const p = position.loadPortfolio(o.account);
  let hs = p.history;
  if (o.code) hs = hs.filter((h) => String(h.code) === String(o.code));
  if (o.from) hs = hs.filter((h) => h.date >= o.from);
  if (o.to) hs = hs.filter((h) => h.date <= o.to);
  if (o.type) hs = hs.filter((h) => h.type === o.type);
  if (o.only) hs = hs.filter((h) => (o.only === 'profit' ? (h.realizedPnl ?? 0) > 0 : o.only === 'loss' ? (h.realizedPnl ?? 0) < 0 : true));
  const buys = hs.filter((h) => h.type === 'buy');
  const sells = hs.filter((h) => h.type === 'sell');
  const buyAmt = buys.reduce((s, h) => s + Number(h.amount), 0);
  const buyFee = buys.reduce((s, h) => s + Number(h.fee), 0);
  const sellAmt = sells.reduce((s, h) => s + Number(h.amount), 0);
  const sellFee = sells.reduce((s, h) => s + Number(h.fee), 0);
  const realized = sells.reduce((s, h) => s + (Number(h.realizedPnl) || 0), 0);
  log(`筛选: ${o.code ? '标的 ' + o.code : '全部'}${o.from ? ' 从' + o.from : ''}${o.to ? ' 至' + o.to : ''}${o.type ? ' 类型' + o.type : ''}${o.only ? ' 仅' + o.only : ''}`);
  log(`统计: 买 ${buys.length} 笔 额${formatYuan(buyAmt)} 费${formatYuan(buyFee)} | 卖 ${sells.length} 笔 额${formatYuan(sellAmt)} 费${formatYuan(sellFee)} | 已实现 ${formatYuan(realized)}`);
  const sortKey = o.sort || 'date';
  const sorted = [...hs].sort((a, b) => sortKey === 'amount' ? (b.amount - a.amount) : sortKey === 'pnl' ? ((Number(b.realizedPnl) || 0) - (Number(a.realizedPnl) || 0)) : String(a.date).localeCompare(String(b.date)));
  const shown = sorted.slice(0, o.limit ? Number(o.limit) : 30);
  log(`明细 (${hs.length} 条，排序 ${sortKey})${hs.length > shown.length ? '，--limit 控制' : ''}:`);
  for (const h of shown) log(`  [#${h.id}] ${h.date} ${h.code} ${h.type} ${h.shares}股 @${formatYuan(h.price)} 费${formatYuan(h.fee)}${h.realizedPnl != null ? ` 已实现${formatYuan(h.realizedPnl)}` : ''}${h.psych ? ` 心理:${h.psych}` : ''}`);
  if (o.group) {
    const g = {};
    for (const h of hs) { const k = o.group === 'month' ? h.date.slice(0, 7) : h.code; g[k] = g[k] || { b: 0, s: 0, ba: 0, sa: 0, r: 0 }; const x = g[k]; if (h.type === 'buy') { x.b++; x.ba += Number(h.amount); } else { x.s++; x.sa += Number(h.amount); x.r += (Number(h.realizedPnl) || 0); } }
    log(`聚合(by ${o.group}):`);
    for (const k in g) log(`  ${k}: 买${g[k].b} 卖${g[k].s} 净额${formatYuan(g[k].sa - g[k].ba)} 已实现${formatYuan(g[k].r)}`);
  }
}

async function cmdPosition(argv) {
  const sub = argv._[0];
  const o = argv.values;
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  switch (sub) {
    case 'init': {
      const c = num(o.capital);
      if (!Number.isFinite(c) || c <= 0) fail('position init 需要 --capital <初始本金（正数）>');
      log(`✔ 初始本金已设: ${formatYuan(position.setCapital(c, o.account))}`);
      return;
    }
    case 'add':
    case 'buy': {
      if (!o.code) fail('position add 需要 --code <代码，如 600519.SH>');
      const s = num(o.shares), pr = num(o.price);
      if (!Number.isFinite(s) || !Number.isFinite(pr)) fail('position add 需要 --shares <股数> 与 --price <价格>');
      let feeVal = num(o.fee);
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = formatYuan(position.estimateFee({ side: 'buy', shares: s, price: pr, account: o.account }));
      const pos = position.addPosition({ code: o.code, name: o.name, shares: s, price: pr, date: o.date, note: o.note, psych: o.psych, fee: feeVal, account: o.account });
      log(`✔ 已记录建仓/加仓: ${pos.code} ${pos.name} 现持仓 ${pos.shares} 股，均价 ${formatYuan(pos.avgCost)}${feeVal ? `（手续费${formatYuan(toCents(feeVal))}）` : ''}${pos.psych ? '（心理备注: ' + pos.psych + '）' : ''}`);
      return;
    }
    case 'sell': {
      if (!o.code) fail('position sell 需要 --code');
      const s = num(o.shares), pr = num(o.price);
      if (!Number.isFinite(s) || !Number.isFinite(pr)) fail('position sell 需要 --shares 与 --price');
      let feeVal = num(o.fee);
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = formatYuan(position.estimateFee({ side: 'sell', shares: s, price: pr, account: o.account }));
      const r = position.sellPosition({ code: o.code, shares: s, price: pr, date: o.date, note: o.note, psych: o.psych, fee: feeVal, account: o.account });
      log(`✔ 已卖出 ${r.code} ${s} 股，已实现盈亏 ${formatYuan(r.realizedPnl)}${r.closed ? '（已清仓）' : ''}${feeVal ? `（手续费${formatYuan(toCents(feeVal))}）` : ''}${o.psych ? '（心理备注: ' + o.psych + '）' : ''}`);
      return;
    }
    case 'psych': {
      if (!o.code || !o.text) fail('position psych 需要 --code 与 --text <心理备注>');
      const r = position.addPsychNote({ code: o.code, date: o.date, text: o.text, account: o.account });
      log(`✔ 已为交易 #${r.id}（${r.code} ${r.shares}股 @${formatYuan(r.price)} ${r.date}）添加心理备注: ${r.psych}`);
      return;
    }
    case 'adjust': {
      if (!o.code) fail('position adjust 需要 --code');
      const r = await position.adjustForDividends(o.code, o.account);
      if (!r.adjusted) log(`未调整 ${o.code}：${r.reason || '无分红/复权事件'}`);
      else log(`✔ 已按除息调整 ${o.code}：持有期累计分红 ${formatYuan(r.totalDivC)} 元/股，成本 ${formatYuan(r.avgBefore)} → ${formatYuan(r.avgAfter)}（浮盈将更贴合券商）`);
      return;
    }
    case 'cash': {
      if (o.amount === undefined) fail('position cash 需要 --amount <现金/逆回购余额，元>');
      const c = position.setCash(o.amount, o.account);
      log(`✔ 已记录现金/逆回购: ${formatYuan(c)} 元`);
      return;
    }
    case 'reset': {
      if (!o.yes) fail('position reset 会清空台账（本金/持仓/历史全部），确认加 --yes');
      const file = position.resetPortfolio(o.account);
      log(`✔ 台账已清空: ${file}（可用 position import 反向重建）`);
      return;
    }
    case 'import': {
      let arr;
      try {
        arr = o.file ? JSON.parse(fs.readFileSync(o.file, 'utf8')) : JSON.parse(o.data);
      } catch (e) { fail(`import 读取失败（--file 指向 JSON 文件或 --data 传 JSON 数组）: ${e.message}`); }
      if (!Array.isArray(arr)) fail('import 需要 JSON 数组 [{type:"buy|sell", code, shares, price, fee?, date?, note?}, ...]');
      const r = position.importTrades(arr, o.account);
      const cap = position.setCapital(formatYuan(r.netInvestC), o.account); // 净投入作为初始本金（分）
      log(`✔ 已导入 ${r.count} 笔交易，净投入 ${formatYuan(cap)} 元 —— 已设为初始本金（如需调整用 position init）`);
      log(`  数据已按"分"精确记录；之后可继续用 add/sell 正向补记。`);
      return;
    }
    case 'list': {
      const r = await position.listPositions(o.account);
      log(`持仓列表（初始本金 ${formatYuan(r.initialCapital)}${r.cash ? ` | 现金 ${formatYuan(r.cash)}` : ''}）:`);
      if (!r.rows.length) { log('  （暂无持仓，用 position add 建仓）'); return; }
      for (const x of r.rows) {
        log(`  ${x.code.padEnd(10)} ${(x.name || '').padEnd(8)} ${x.shares}股 成本${formatYuan(x.avgCost)} 现价${formatYuan(x.price)} 市值${formatYuan(x.marketValue)} 盈亏${formatYuan(x.pnl)}(${x.pnlPct}%)`);
      }
      return;
    }
    case 'summary': {
      const s = await position.summary(o.account);
      log('持仓总览:');
      log(`  持仓数 ${s.positionCount} | 本金 ${formatYuan(s.initialCapital)} | 投入成本 ${formatYuan(s.totalCostC)}`);
      log(`  股票市值 ${formatYuan(s.marketValueC)} | 现金 ${formatYuan(s.cash)} | 总资产 ${formatYuan(s.totalAssetsC)}`);
      log(`  浮动盈亏 ${formatYuan(s.floatPnl)} | 已实现 ${formatYuan(s.realizedPnl)} | 合计盈亏 ${formatYuan(s.totalPnl)}`);
      return;
    }
    case 'today': {
      const t = position.dayTrades(o.date, o.account);
      log(`当日交易流水（${o.date || '今天'}）: ${t.length ? '' : '（无）'}`);
      for (const h of t) log(`  [#${h.id ?? '-'}] [${h.type}] ${h.code} ${h.name} ${h.shares}股 @${formatYuan(h.price)}${h.fee ? ` 手续费${formatYuan(h.fee)}` : ''}${h.realizedPnl != null ? ` 已实现 ${formatYuan(h.realizedPnl)}` : ''}${h.psych ? ` 心理: ${h.psych}` : ''}${h.note ? ' ' + h.note : ''}`);
      return;
    }
    case 'query': {
      return cmdPositionQuery(o);
    }
    default:
      fail('position 支持: init --capital N | add --code X --shares N --price P [--name --date --note --psych --fee N | --auto-fee [--account 名称]] | sell ... | psych --code X --text "..." | adjust --code X（除息复权成本调整） | cash --amount N（现金/逆回购） | import --file trades.json | reset --yes | list | summary | today [--date D] | query [--code X --from D --to D --type buy|sell --only profit|loss --sort date|amount|pnl --limit N --group code|month]');
  }
}

// ── 配置：node cli.js config [--init|--template|--status] ──────────────────
async function promptYesNo(question) {
  const rl = createInterface({ input, output });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    if (ans === 'y' || ans === 'yes' || ans === '是') return true;
    if (ans === 'n' || ans === 'no' || ans === '否') return false;
    return null;
  } catch {
    return null; // 非交互环境（管道/EOF）
  } finally {
    rl.close();
  }
}

function sampleConfig() {
  const sample = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'config.example.json'), 'utf8'));
  if (sample.fuyao) sample.fuyao.apiKey = ''; // 双保险：不落敏感值
  return sample;
}

function writeConfigFile(target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(sampleConfig(), null, 2));
  return target;
}

async function cmdConfig(opts) {
  if (opts.status) {
    if (isConfigPresent()) {
      log(`配置已存在: ${USER_CONFIG_PATH}`);
    } else {
      log(`[CONFIG_MISSING] 未检测到配置文件: ${USER_CONFIG_PATH}`);
      log('创建方式: node cli.js config --init（生成后编辑填写）或 --template（生成模板自行创建）');
    }
    return;
  }
  if (opts.init) {
    const p = writeConfigFile(USER_CONFIG_PATH);
    log(`✔ 已生成配置文件: ${p}`);
    log('  请编辑填写 noteRoot / cacheRoot / fuyao.apiKey（官网 https://fuyao.aicubes.cn 签发）');
    return;
  }
  if (opts.template) {
    const p = writeConfigFile(path.join(homeDir(), 'config.template.json'));
    log(`✔ 已生成模板: ${p}`);
    log(`  请参照模板自行创建 ${USER_CONFIG_PATH} 并填写 noteRoot / cacheRoot / fuyao.apiKey`);
    return;
  }
  // 交互模式：先问用户，得到同意才生成（非 TTY 环境不尝试交互，直接给指引）
  if (isConfigPresent()) {
    log(`配置已存在: ${USER_CONFIG_PATH}`);
    return;
  }
  log(`[CONFIG_MISSING] 未检测到配置文件: ${USER_CONFIG_PATH}`);
  if (!input.isTTY) {
    log('非交互环境：请运行 `node cli.js config --init`（直接生成）或 `config --template`（生成模板），或让用户在会话中确认后创建。');
    process.exitCode = 1;
    return;
  }
  const ans = await promptYesNo('是否生成配置文件？（y=直接生成 / n=生成模板由你自行创建）: ');
  if (ans === true) {
    const p = writeConfigFile(USER_CONFIG_PATH);
    log(`✔ 已生成: ${p}，请编辑填写 noteRoot / cacheRoot / fuyao.apiKey`);
  } else if (ans === false) {
    const p = writeConfigFile(path.join(homeDir(), 'config.template.json'));
    log(`✔ 已生成模板: ${p}，请参照模板自行创建 ${USER_CONFIG_PATH}`);
  } else {
    log('非交互环境：请运行 `node cli.js config --init`（直接生成）或 `config --template`（生成模板）。');
    process.exitCode = 1;
  }
}

// ── 帮助 ───────────────────────────────────────────────────────────────────
function cmdHelp() {
  log(`A股助手 CLI (dsh-a-share-assistant)
用法: node src/cli.js <command> [options]

命令:
  check                     数据链路体检（网络/Key/端点/缓存）
  config [--init|--template|--status]
                            配置文件管理：无参数=交互询问（先问后建）；--init 直接生成；
                            --template 生成模板自行创建；--status 查看状态
  cache status              缓存状态（索引/磁盘）
  cache snapshot --type T --file F|--data J [--date D] [--code X]
                            存储快照（--code 时存为个股级 stocks/<code>/）
  cache latest   --type T [--code X]
                            取最近一份（--code 时查个股缓存）
  cache get      --type T --date D
                            取指定日期快照
  cache clean    [--keep-days N]
                            清理归档（默认近30天保留）
  data           --kind K [参数] [--save T [--code X] [--date D] | --summary]
                            取数并可选落缓存（--save 指定缓存类型；--code 存个股级）。
                            默认输出完整 JSON；--summary 只出简化摘要，--save 落盘不打印（省 token）
  investigate    --code X [--report YYYY-N]
                            一键个股体检（拉齐行情/三表/估值/异动并落盘）
  daily-snapshot [--date D]  一键每日复盘快照（涨停/跌停/炸板/连板/龙虎榜/热榜/板块/指数落盘）

data 常用参数: --q / --thscodes / --thscode / --period annual|quarterly
  --limit / --report YYYY-N / --date / --start --end（YYYY-MM-DD 或毫秒戳）
  --interval 1d（K线必传）/ --adjust none|forward|backward / --from --to（区间日期）
  --tag cn_concept|industry / --tag-codes LIMIT_UP,SHARP_FALL（异动标签）
  --start-date --end-date（热榜走势日期）
  --board-type all|org|hot_money / --page / --size / --sort-field / --sort-dir

  position       init --capital N | add --code X --shares N --price P
                 [--name --date --note --psych --fee N | --auto-fee [--account 名称]]
                 | sell --code X --shares N --price P [--date --psych --fee|--auto-fee]
                 | psych --code X --text "..." [--date D] | adjust --code X（除息复权成本调整）
                 | cash --amount N（现金/逆回购）| import --file F | reset --yes | list | summary | today [--date D]
position 参数: --fee 手续费（买入计入成本/卖出从已实现盈亏扣）；--auto-fee 按费率自动估算；
  --account <账户> 用配置 feeProfiles 的对应费率（多账户）；--psych 心理备注；--name 名称
  query      多维度查询：--code X --from D --to D --type buy|sell --only profit|loss
             --sort date|amount|pnl --limit N --group code|month（含统计/明细/聚合）

可用端点:`);
  for (const [kind, spec] of Object.entries(ENDPOINTS)) {
    log(`  ${kind.padEnd(24)} ${spec.note}`);
  }
}

export async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      init: { type: 'boolean' }, template: { type: 'boolean' }, status: { type: 'boolean' },
      help: { type: 'boolean' }, full: { type: 'boolean' }, quick: { type: 'boolean' }, summary: { type: 'boolean' },
      yes: { type: 'boolean' },
      capital: { type: 'string' }, name: { type: 'string' }, shares: { type: 'string' },
      price: { type: 'string' }, note: { type: 'string' }, psych: { type: 'string' }, text: { type: 'string' }, fee: { type: 'string' }, amount: { type: 'string' },
      'auto-fee': { type: 'boolean' }, account: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, sort: { type: 'string' },
      group: { type: 'string' }, only: { type: 'string' },
      kind: { type: 'string' }, type: { type: 'string' },
      code: { type: 'string' },
      date: { type: 'string' }, 'date-ms': { type: 'string' },
      file: { type: 'string' }, data: { type: 'string' },
      'keep-days': { type: 'string' },
      save: { type: 'string' },
      q: { type: 'string' }, thscodes: { type: 'string' }, thscode: { type: 'string' },
      limit: { type: 'string' }, offset: { type: 'string' }, interval: { type: 'string' },
      start: { type: 'string' }, end: { type: 'string' }, adjust: { type: 'string' },
      period: { type: 'string' }, report: { type: 'string' }, tag: { type: 'string' },
      'board-type': { type: 'string' }, page: { type: 'string' }, size: { type: 'string' },
      'sort-field': { type: 'string' }, 'sort-dir': { type: 'string' },
      stage: { type: 'string' }, exchange: { type: 'string' }, 'asset-type': { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' },
      'tag-codes': { type: 'string' }, 'start-date': { type: 'string' }, 'end-date': { type: 'string' },
    },
  });

  const cmd = positionals[0];
  if (cmd === 'check') return cmdCheck(values);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return cmdHelp();
  if (cmd === 'config') return cmdConfig(values);
  if (cmd === 'cache') return cmdCache({ _: positionals.slice(1), values });
  if (cmd === 'position') return cmdPosition({ _: positionals.slice(1), values });
  if (cmd === 'investigate') return cmdInvestigate(values);
  if (cmd === 'daily-snapshot') return cmdDailySnapshot(values);
  if (cmd === 'data') return cmdData(values);
  log('A股助手 CLI: node src/cli.js <check|config|cache|position|data|investigate|daily-snapshot|help>（跑 help 看全部用法）');
  process.exitCode = 1;
}

main().catch((e) => fail(e.message));

