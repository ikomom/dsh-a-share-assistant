#!/usr/bin/env node
// A股助手 CLI：环境自检 + 配置管理 + 缓存管理 + 取数
import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ping, dataLinkProbe, getData, ENDPOINTS, ERROR_CODE_HINTS, toMsTimestamp } from './fuyao.js';
import * as cache from './cache.js';
import * as position from './position.js';
import { buildHoldingsHtml } from './report-html.js';
import { fetchMarketContext, fetchMarketBreadth, resolveTradingDay } from './market.js';
import * as iwencai from './iwencai.js';
import { formatYuan, toCents, formatMilli } from './money.js';
import { CACHE_ROOT, PROJECT_ROOT, NOTES_ROOT, reviewDir, getApiKey, getConfigSource, USER_CONFIG_PATH, homeDir, isConfigPresent } from './config.js';

/** 插件版本（check 输出；会话中若代码被更新，可据此识别新旧） */
export const CLI_VERSION = '0.1.3';

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
  log(`复盘目录: ${reviewDir()}（笔记与报告同处；config.reviewDir 可覆盖）`);
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
  // 问财渠道（公告/新闻/研报/选股/事件/股东…）：Key + 技能脚本是否就位，属"链路就绪"的一部分
  const iw = iwencai.channelStatus();
  const iwOk = iw.keyOk && iw.missing.length === 0;
  log(`问财渠道(可选): ${iw.installed}/${iw.total} 个技能已装${iw.keyOk ? '，Key ✅' : '，⚠缺Key'}${iwOk ? ' ✅' : ''}`);
  if (!iwOk && !opts.quick) {
    if (!iw.keyOk) log('  开启方式① 填 Key：把 iwencai.apiKey 写进上面那个 config.json（https://www.iwencai.com/skillhub 获取）');
    if (iw.missing.length) log(`  开启方式② 装技能：node scripts/install-iwencai-skills.mjs --skills ${iw.missing.slice(0, 3).map((m) => m.slug).join(',')}${iw.missing.length > 3 ? ',…' : ''}`);
    log(`  不开也不影响主链路：行情/财务/涨停龙虎榜/复盘/持仓分析照常；只是没有问财那 ${iw.total} 个通道（${iw.rows.slice(0, 6).map((r) => r.label).join('/')}…）`);
  }
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
  log('  ETF/基金:       --thscode 510300.SH（单只）；fund-market-historical/fund-profile/fund-returns/fund-nav/fund-drawdowns/fund-holdings/fund-diagnostics');
  log('  全市场导出:     --kind market-dump-url --dump daily-k|daily-k-10d|adjustment-factors（Parquet 链接 5 分钟失效）');
  log('  ⛔ 不可用:       主力资金/高频动向（官方仅对同花顺AI客户端开放，code=2004）——不要试调');
  log('  持仓股分析:      position review（成本/止损/目标/买入区 vs 当日行情 → 分组判定 + HTML 报告）');
  log('  消息面(问财):    search --channel announcement|news --q "标的 事件"（公告全文 / 新闻+研报）');
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
// 日期→毫秒戳的归一化在 fuyao.js 的 getData 内统一处理（toMsTimestamp），此处不再重复转换
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
    if (spec.blocked) log(`状态: ❌ 外部不可用 —— ${spec.blocked}`);
    const req = spec.params?.required ?? [];
    log(`必填参数: ${req.length ? req.join(', ') : '无'}`);
    for (const [name, allowed] of Object.entries(spec.params?.enum ?? {})) log(`  ${name} 取值: ${allowed.join(' | ')}`);
    if (spec.params?.warn) log(`注意: ${spec.params.warn}`);
    if (spec.params?.example) log(`示例: node ${PROJECT_ROOT}/src/cli.js ${spec.params.example}`);
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
    // ETF / 基金 专用
    dump: opts.dump, nav_type: opts['nav-type'], range: opts.range,
    report_type: opts['report-type'], report_period: opts['report-period'],
    subscribe: opts.subscribe, manager_id: opts['manager-id'], company_id: opts['company-id'],
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
    const dup = e.message.includes(`端点 ${kind}`);
    fail(`取数失败: ${e.message}${spec && !dup ? `（端点 ${kind}: ${spec.note}）` : ''}`);
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

// ── 消息面检索（问财渠道）：node cli.js search --channel announcement|news --q "..." ──
// 公告 = 沪深北公告全文检索（带原文/PDF 链接）；news = 官媒/财经媒体/行业站 + 券商研报摘要
async function cmdSearch(o) {
  const channel = o.channel || 'news';
  if (!iwencai.CHANNELS[channel]) fail(`search 需要 --channel <${Object.keys(iwencai.CHANNELS).join('|')}>（当前: ${channel}）`);
  if (!o.q) fail('search 需要 --q "<自然语言检索词>"，如 --q "贵州茅台 分红公告"');
  let r;
  try {
    r = await iwencai.search({ channel, query: o.q, size: o.size ? Number(o.size) : 10, includeRaw: !!o.raw });
  } catch (e) {
    fail(`检索失败: ${e.message}`);
  }
  if (o.save) {
    const date = o.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const f = cache.saveSnapshot({ type: o.save, date, data: { channel: r.channel, query: r.query, total: r.total, items: r.items } });
    log(`已检索并缓存: ${f}（${r.label} ${r.items.length}/${r.total} 条）`);
    return;
  }
  if (o.raw && r.raw) { console.log(r.raw); return; }
  if (o.summary) {
    log(`${r.label}检索「${r.query}」：共 ${r.total} 条（返回 ${r.items.length}）`);
    if (r.columns && r.columns.length) {
      // B 形态（选股/行情/财务/事件/股东/宏观…）：中文列表格，逐行紧凑打印
      const cols = r.columns.slice(0, 8);
      log(`  列: ${cols.join(' | ')}${r.columns.length > cols.length ? ` …（共 ${r.columns.length} 列）` : ''}`);
      for (const it of r.items) log(`  - ${cols.map((c) => `${c}=${it[c] ?? ''}`).join(' | ')}`);
    } else {
      for (const it of r.items) log(`  ${it.date} | ${it.title} | ${it.source}${it.url ? ' | ' + it.url : ''}`);
    }
    return;
  }
  const { raw, ...out } = r;
  console.log(JSON.stringify(out, null, 2));
}

// ── 一键体检：node cli.js investigate --code X [--report YYYY-N] ──
// 股票 → 行情/三表/估值/异动；ETF/场内基金 → 行情/资料/收益/回撤/持仓/诊断（自动判别）
/** ETF 行情兜底：快照未就绪（code=3002/停牌）时用最近一根前复权日线收盘价，并标明来源 */
async function etfQuoteWithFallback(code, d) {
  const snap = await getData('fund-market-snapshot', { thscode: code });
  const it = snap?.data?.item?.[0];
  if (snap?.code === 0 && it) return { ...snap, source: 'fund-market-snapshot(实时快照)' };
  const hist = await getData('fund-market-historical', { thscode: code, interval: '1d', start: d(15), end: d(0) });
  const items = hist?.data?.item ?? [];
  const last = items[items.length - 1];
  if (hist?.code !== 0 || !last) throw new Error(`快照未就绪(code=${snap?.code})，日线兜底也失败(code=${hist?.code})`);
  return {
    code: 0,
    message: `快照未就绪(code=${snap?.code})，已用最近日线收盘兜底`,
    source: 'fund-market-historical(最近日线收盘，前复权)',
    data: { timestamp: last.date_ms, item: [{ thscode: code, ticker: code.split('.')[0], last_price: last.close_price, date_ms: last.date_ms }] },
  };
}

async function cmdInvestigate(opts) {
  if (!opts.code) fail('investigate 需要 --code <代码，如 600519.SH 或 510300.SH>');
  const code = opts.code;
  const isFund = position.assetTypeOf(code) === 'etf';
  // 按 Asia/Shanghai 取日期（sv-SE 输出 YYYY-MM-DD），近 120 天 K 线窗口
  const d = (n) => new Date(Date.now() - n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  // 一次拉齐体检常用数据并落盘（indicators 需报告期，另取）
  const jobs = isFund
    ? [
        ['quote', null, null, () => etfQuoteWithFallback(code, d)],
        ['kline', 'fund-market-historical', { thscode: code, interval: '1d', start: d(120), end: d(0) }],
        ['profile', 'fund-profile', { thscode: code }],
        ['returns', 'fund-returns', { thscode: code }],
        ['drawdowns', 'fund-drawdowns', { thscode: code }],
        ['holdings', 'fund-holdings', { thscode: code }],
        ['diagnostics', 'fund-diagnostics', { thscode: code }],
      ]
    : [
        ['quote', 'price-snapshot', { thscodes: code }],
        ['income', 'income-statements', { thscode: code, period: 'quarterly', limit: 4 }],
        ['balance', 'balance-sheets', { thscode: code, period: 'quarterly', limit: 4 }],
        ['cashflow', 'cash-flow-statements', { thscode: code, period: 'quarterly', limit: 4 }],
        ['valuation', 'valuations-snapshot', { thscodes: code }],
        ['event', 'anomaly-analysis-stock', { thscodes: code }],
      ];
  if (!isFund && opts.report) jobs.push(['indicators', 'financial-indicators', { thscode: code, report: opts.report }]);
  log(`一键体检 ${code}${isFund ? ' [ETF/场内基金]' : ''}：`);
  const results = await Promise.all(jobs.map(async ([type, kind, params, custom]) => {
    try {
      const r = custom ? await custom() : await getData(kind, params);
      if (r && r.code !== undefined && r.code !== 0) throw new Error(`code=${r.code} ${r.message}`);
      const f = cache.saveStock({ code, type, data: r.data ?? r });
      return { type, ok: true, file: path.basename(f), note: r?.source };
    } catch (e) {
      return { type, ok: false, err: e.message };
    }
  }));
  for (const x of results) log(x.ok ? `  ✔ ${x.type.padEnd(10)} ${x.file}` : `  ✗ ${x.type.padEnd(10)} ${x.err}`);
  for (const x of results) if (x.note) log(`  ℹ ${x.type} 数据来源: ${x.note}`);
  log(`  完成: ${results.filter((x) => x.ok).map((x) => x.type).join('、')}`);
  if (isFund) log(`  提示: 基金数据为定期披露口径；再取净值序列 data --kind fund-nav --thscode ${code} --range year`);
  else log(`  财务指标另取: data --kind financial-indicators --thscode ${code} --report YYYY-N（或用 --report 一并取）`);
}

// ── 一键每日复盘快照：node cli.js daily-snapshot [--date D] ──
async function cmdDailySnapshot(opts) {
  const date = opts.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const idx = '000001.SH,399001.SZ,399006.SZ';
  // 按「最近交易日」取池：涨停/跌停/炸板池省略 date_ms 时按自然日取，周末与节假日会返回空池
  let td = null;
  try { td = await resolveTradingDay(date); } catch { /* 交易日历失败就退回默认取法 */ }
  if (td && td.isTradingDay === false) log(`提示: ${date} 不是交易日 → 涨跌停/龙虎榜按最近交易日 ${td.date} 取`);
  const poolParams = td ? { date_ms: String(td.ms) } : {};
  const jobs = [
    ['limit-up', 'limit-up-pool', poolParams],
    ['limit-down', 'limit-down-pool', poolParams],
    ['limit-break', 'limit-break-pool', poolParams],
    ['ladder', 'limit-up-ladder', {}],
    ['dragon-tiger', 'dragon-tiger-list', td ? { date: td.date, board_type: 'all' } : {}],
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
  // 全市场涨跌家数（广度）：一次全市场快照 + 本地聚合，只落统计值（明细 1.2MB 不进上下文）
  try {
    const mb0 = await fetchMarketBreadth();
    const mb = { ...mb0, snapshotDate: mb0.date, date: td ? td.date : mb0.date };
    const f = cache.saveSnapshot({ type: 'breadth', date, data: mb });
    log(`  ✔ ${'breadth'.padEnd(12)} ${path.basename(f)}  涨${mb.up}/跌${mb.down}/平${mb.flat}（共 ${mb.total} 只，数据日期 ${mb.date}）`);
  } catch (e) {
    log(`  ✗ ${'breadth'.padEnd(12)} ${e.message}`);
  }
  log(`  完成: ${results.filter((x) => x.ok).map((x) => x.type).join('、')}、breadth`);
  log(`  复盘时用 cache latest --type <limit-up|dragon-tiger|sectors|hot-stock|index|breadth|...> 读取`);
}

// ── 持仓股分析：node cli.js position review [--date D] [--html|--no-html] [--out 路径] [--no-md] ──
/** 解析 --zone 8.65-8.85 / 8.65~8.85 / 8.65（单值=上沿） */
function parseZone(v) {
  if (v === undefined || v === null || v === '') return { low: undefined, high: undefined };
  const m = String(v).split(/[-~,，]/).map((x) => x.trim()).filter(Boolean);
  if (!m.length) return { low: undefined, high: undefined };
  return { low: m.length > 1 ? m[0] : undefined, high: m.length > 1 ? m[1] : m[0] };
}

function planText(pos) {
  const bits = [];
  const pm = (m) => formatMilli(m, m % 10 === 0 ? 2 : 3);
  if (pos.zoneLowMilli || pos.zoneHighMilli) bits.push(`买入区 ${pos.zoneLowMilli ? pm(pos.zoneLowMilli) : '?'}-${pos.zoneHighMilli ? pm(pos.zoneHighMilli) : '?'}`);
  if (pos.targetMilli) bits.push(`目标 ${pm(pos.targetMilli)}`);
  if (pos.stopMilli) bits.push(`止损 ${pm(pos.stopMilli)}`);
  return bits.length ? bits.join(' ｜ ') : '（无计划参数）';
}

const yuanOr = (v) => (v === null || v === undefined || v === '' ? '—' : formatYuan(v));
const pctOr = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${v}%`);
/** 行情价（厘）→ 元字符串：ETF/基金三位小数，股票两位 */
const priceOr = (milli) => (milli === null || milli === undefined || milli === '' ? '—' : formatMilli(milli, Number(milli) % 10 === 0 ? 2 : 3));
// 中文占 2 列的显示宽度对齐（padEnd 按字符数会错位）
const dispWidth = (s) => [...String(s)].reduce((n, ch) => n + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
const padDisp = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));
const padStartDisp = (s, n) => ' '.repeat(Math.max(0, n - dispWidth(s))) + String(s);

/** 持仓分析的 Markdown 段落（供贴进复盘笔记；不改模板，只产出片段） */
function reviewMarkdown(a) {
  const s = a.summary;
  const L = [];
  L.push(`## 持仓股分析（${a.date}）`);
  L.push('');
  L.push(`> 口径：成本/止损/目标/买入区来自交易台账，行情来自同花顺金融数据 API（${a.rows.some((r) => r.dataSource === '实时快照') ? '实时快照' : '最近交易日日线'}）。判定规则：当日最低 ≤ 买入区上沿且收盘 ≥ 止损 → 可低吸；触/逼第一目标 → 止盈；跌破买区下沿/逼近止损 → 止损预警。只标注「计划 vs 现实」偏差，不换股、不改计划参数。`);
  L.push('');
  L.push('| 标的 | 股数 | 成本 | 现价 | 当日 | 止损 | 目标 | 浮动盈亏 | 触发状态 |');
  L.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | :--- |');
  for (const r of a.rows) {
    L.push(`| ${r.name}(${r.code})${r.isEtf ? ' ETF' : ''} | ${r.shares} | ${yuanOr(r.avgCost)} | ${priceOr(r.priceMilli)} | ${pctOr(r.changePct)} | ${priceOr(r.stop)} | ${priceOr(r.target)} | ${yuanOr(r.floatPnl)}（${pctOr(r.floatPnlPct)}） | ${r.badge} |`);
  }
  L.push('');
  L.push(`**汇总**：成本 ${yuanOr(s.costC)} ｜ 市值 ${yuanOr(s.marketValueC)} ｜ 浮动盈亏 ${yuanOr(s.floatPnlC)}（${pctOr(s.floatPnlPct)}） ｜ 现金 ${yuanOr(s.cash)}`);
  L.push('');
  for (const g of a.groups) {
    const meta = { stop: '⚠️ 止损预警', target: '🎯 止盈', zone: '✅ 计划买区', hold: '➖ 持有观察' }[g.group];
    L.push(`**${meta}（${g.rows.length} 只）**`);
    for (const r of g.rows) {
      const dist = [r.distStopPct !== null ? `距止损 ${pctOr(r.distStopPct)}` : '', r.distTargetPct !== null ? `距目标 ${pctOr(r.distTargetPct)}` : ''].filter(Boolean).join(' ｜ ');
      L.push(`- **${r.name}(${r.code})** 现价 ${priceOr(r.priceMilli)}（${pctOr(r.changePct)}）${dist ? ` ｜ ${dist}` : ''} ｜ 操作：${r.action}`);
    }
    L.push('');
  }
  if (s.planMissing) L.push(`> 提示：${s.planMissing} 只持仓未记止损/目标/买入区，只做了成本盈亏分析——用 \`position plan --code X --stop S --target T --zone A-B\` 补齐后可参与触发判定。`);
  if (s.missingQuote.length) L.push(`> ⚠️ 未取到行情（按成本价计，浮盈为假象）：${s.missingQuote.join('、')}`);
  return L.join('\n');
}

async function cmdPositionReview(o) {
  const a = await position.analyzeHoldings({ date: o.date, account: o.account });
  a.generatedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const s = a.summary;
  if (!a.rows.length && !s.tradeCount) {
    log('（台账无持仓、当日也无交易，用 position add 建仓后再做持仓分析）');
    return;
  }
  // 市场环境（大盘/板块/情绪）：--no-market 可跳过（省时省请求）
  let market = null;
  if (!o['no-market']) {
    try {
      market = await fetchMarketContext({ date: a.date });
    } catch (e) {
      log(`⚠ 市场环境取数失败（不影响持仓分析）: ${e.message}`);
    }
  }
  // 风险日历：由 AI 复盘时用 web 搜索补，通过 --events 传入（不编造）
  let events = [];
  if (o.events) {
    try {
      const raw = /^[\[{]/.test(String(o.events).trim()) ? o.events : fs.readFileSync(o.events, 'utf8');
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : parsed.events ?? [];
      if (!Array.isArray(events)) throw new Error('events 需要是数组 [{date,title,impact?,source?}]');
    } catch (e) {
      fail(`--events 解析失败（传 JSON 数组或文件路径）: ${e.message}`);
    }
  }
  log(`== 持仓股分析 ${a.date}${o.account ? ' [' + o.account + ']' : ''} ==`);
  if (market) {
    const idx = market.indices.map((x) => `${x.name} ${x.changePct === null ? '—' : pctOr(x.changePct)}`).join(' ｜ ');
    log(`大盘: ${idx}`);
    if (market.breadth) log(`情绪: 涨停 ${market.breadth.limitUp} ｜ 跌停 ${market.breadth.limitDown} ｜ 炸板 ${market.breadth.limitBreak} ｜ 封板率 ${market.breadth.sealRate === null ? '—' : market.breadth.sealRate + '%'}${market.ladder?.maxBoard ? ` ｜ 最高 ${market.ladder.maxBoard} 板` : ''}`);
    if (market.marketBreadth) log(`广度: 全市场 ${market.marketBreadth.total} 只 ｜ 涨 ${market.marketBreadth.up} / 跌 ${market.marketBreadth.down} / 平 ${market.marketBreadth.flat}（数据日期 ${market.marketBreadth.date}）`);
    if (market.sectors.flatLine) log(`概念: 涨 ${market.sectors.flatLine.up} / 跌 ${market.sectors.flatLine.down}（共 ${market.sectors.total} 个）`);
    if (market.sectors.gainers.length) log(`领涨: ${market.sectors.gainers.slice(0, 5).map((x) => `${x.name} ${pctOr(x.changePct)}`).join(' ｜ ')}`);
    if (market.sectors.losers.length) log(`领跌: ${market.sectors.losers.slice(0, 5).map((x) => `${x.name} ${pctOr(x.changePct)}`).join(' ｜ ')}`);
    if (market.errors?.length) log(`⚠ 市场环境部分失败: ${market.errors.join('；')}`);
  }
  if (s.tradeCount) {
    log(`今日交易（${s.tradeCount} 笔，手续费 ${formatYuan(s.dayFeesC)}，已实现 ${formatYuan(s.dayRealizedC)}）:`);
    for (const t of a.trades) log(`  ${t.time || '--:--:--'} [${t.type === 'buy' ? '买' : '卖'}] ${t.code} ${t.name} ${t.shares}股 @${t.priceText}${t.realizedPnl !== null ? ` 已实现 ${formatYuan(t.realizedPnl)}` : ''}${t.psych ? ` 心理: ${t.psych}` : ''}`);
  } else {
    log('今日交易: 无');
  }
  log('');
  // 列宽自适应：全都没计划参数时不占"止损/目标"两列；徽标缩短、日期后置，避免终端折行
  const showPlan = a.rows.some((r) => r.stop || r.target);
  const shortBadge = (b) => String(b).replace('（未设计划参数）', '(无计划)').replace('（', '(').replace('）', ')');
  log(showPlan
    ? '代码       名称           股数      成本     现价    当日     止损     目标      浮动盈亏        触发状态              建仓/持有'
    : '代码       名称           股数      成本     现价    当日      浮动盈亏        触发状态              建仓/持有');
  for (const r of a.rows) {
    const base = `${padDisp(r.code, 11)} ${padDisp(r.name || '', 15)} ${padStartDisp(String(r.shares), 6)} ${padStartDisp(yuanOr(r.avgCost), 8)} ${padStartDisp(priceOr(r.priceMilli), 8)} ${padStartDisp(pctOr(r.changePct), 7)} ${showPlan ? `${padStartDisp(priceOr(r.stop), 8)} ${padStartDisp(priceOr(r.target), 8)} ` : ''}`;
    const pnl = padStartDisp(`${yuanOr(r.floatPnl)}(${pctOr(r.floatPnlPct)})`, 15);
    const held = `${(r.openDate || '—').slice(5)}${r.holdingDays !== null && r.holdingDays !== undefined ? '/' + r.holdingDays + '天' : ''}`;
    log(`${base}${pnl}  ${padDisp(shortBadge(r.badge), 21)}${held}${r.quoteMissing ? ' ⚠缺行情' : ''}`);
  }
  log('');
  for (const g of a.groups) {
    const meta = { stop: '⚠️ 止损预警组', target: '🎯 止盈组', zone: '✅ 计划买区组', hold: '➖ 持有观察组' }[g.group];
    log(`${meta}（${g.rows.length} 只）`);
    for (const r of g.rows) log(`  ${r.code} ${r.name}：${r.action}`);
  }
  log('');
  log(`汇总: 持仓 ${s.count} 只（有效行情 ${s.validCount}）| 成本 ${yuanOr(s.costC)} | 市值 ${yuanOr(s.marketValueC)} | 浮动盈亏 ${yuanOr(s.floatPnlC)}(${pctOr(s.floatPnlPct)}) | 现金 ${yuanOr(s.cash)}`);
  if (s.planMissing) log(`提示: ${s.planMissing} 只未记计划参数（只做成本盈亏分析）——position plan --code X --stop S --target T --zone A-B 补齐后可参与触发判定`);
  if (s.missingQuote.length) log(`⚠ 未取到行情、按成本价计（浮盈为假象）: ${s.missingQuote.join(', ')}`);

  // Markdown 片段（默认打印，便于贴进复盘笔记）
  if (!o['no-md']) {
    log('');
    log('----- Markdown 片段（可直接贴进复盘笔记）-----');
    log(reviewMarkdown(a));
    log('----- 片段结束 -----');
  }
  if (o['md-file']) {
    fs.writeFileSync(o['md-file'], reviewMarkdown(a) + '\n', 'utf8');
    log(`✔ Markdown 已写入: ${o['md-file']}`);
  }
  // HTML 报告（默认生成单文件，--no-html 关闭）
  // 默认落 {复盘目录}/持仓分析/ 子目录 —— 复盘目录由 config.reviewDir / 自动探测决定（见 config.js reviewDir()），
  // 与复盘笔记 YYYY-MM-DD.md 同处一层、按类型归档，不把报告平铺在复盘根目录；--out 可覆盖。
  if (!o['no-html']) {
    const file = o.out || path.join(reviewDir(), '持仓分析', `持仓分析${o.account ? '-' + o.account : ''}-${a.date}.html`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buildHoldingsHtml({ analysis: a, market, events, options: { generatedAt: a.generatedAt } }), 'utf8');
    const sec = [market ? `${market.sectors.gainers.length + market.sectors.losers.length} 个板块` : '', events.length ? `${events.length} 条风险日历` : '风险日历待补'].filter(Boolean).join(' + ');
    log(`✔ HTML 报告已生成: ${file}（单文件自包含，ECharts 已内联，断网也能出图；含大盘/板块/${sec}）`);
  }
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
  for (const h of shown) log(`  [#${h.id}] ${h.date}${h.time ? ' ' + h.time : ''} ${h.code} ${h.type} ${h.shares}股 @${formatYuan(h.price)} 费${formatYuan(h.fee)}${h.realizedPnl != null ? ` 已实现${formatYuan(h.realizedPnl)}` : ''}${h.psych ? ` 心理:${h.psych}` : ''}`);
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
  if (o.help) return cmdHelp(); // position --help：打印用法（不执行子命令，避免误触发取数/落盘）
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
      // estimateFee 返回「分」；addPosition 的 fee 入参是「元」（内部 toCents），故先 /100 转元
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = position.estimateFee({ side: 'buy', shares: s, price: pr, account: o.account }) / 100;
      const pl = parseZone(o.zone);
      const pos = position.addPosition({ code: o.code, name: o.name, shares: s, price: pr, date: o.date, note: o.note, psych: o.psych, fee: feeVal, stop: o.stop, target: o.target, zoneLow: pl.low, zoneHigh: pl.high, account: o.account });
      log(`✔ 已记录建仓/加仓: ${pos.code} ${pos.name} 现持仓 ${pos.shares} 股，均价 ${formatYuan(pos.avgCost)}${feeVal ? `（手续费${formatYuan(toCents(feeVal))}）` : ''}${pos.psych ? '（心理备注: ' + pos.psych + '）' : ''}`);
      if (pos.stopC || pos.targetC || pos.zoneLowC || pos.zoneHighC) log(`  计划参数: ${planText(pos)}`);
      return;
    }
    case 'plan': {
      if (!o.code) fail('position plan 需要 --code');
      if (o.stop === undefined && o.target === undefined && o.zone === undefined) fail('position plan 至少给一项: --stop <价> --target <价> --zone <低-高>（传 0 清除该项）');
      const pl = parseZone(o.zone);
      const pos = position.setPlan({ code: o.code, stop: o.stop, target: o.target, zoneLow: pl.low, zoneHigh: pl.high, account: o.account });
      log(`✔ 计划参数已更新: ${pos.code} ${pos.name} —— ${planText(pos)}`);
      return;
    }
    case 'review': {
      return cmdPositionReview(o);
    }
    case 'sell': {
      if (!o.code) fail('position sell 需要 --code');
      const s = num(o.shares), pr = num(o.price);
      if (!Number.isFinite(s) || !Number.isFinite(pr)) fail('position sell 需要 --shares 与 --price');
      let feeVal = num(o.fee);
      // 同上：estimateFee 返回「分」，先 /100 转成「元」再传
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = position.estimateFee({ side: 'sell', shares: s, price: pr, account: o.account }) / 100;
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
      log(`✔ 已记录现金: ${formatYuan(c)} 元`);
      return;
    }
    case 'repo': {
      const act = argv._[1] || 'list';
      if (act === 'add') {
        if (o.amount === undefined || o.rate === undefined) fail('position repo add 需要 --amount <元> --rate <年化%> [--days 1] [--code 204001] [--date D]');
        const r = position.addRepo({ code: o.code, amount: o.amount, rate: o.rate, days: o.days || 1, date: o.date, note: o.note, account: o.account });
        log(`✔ 已记逆回购 #${r.id} ${r.code} ${formatYuan(r.amountC)} 元 @${r.rate}% ${r.days}天，到期 ${r.dueDate}，预期收益 ${formatYuan(r.interestC)}`);
        return;
      }
      if (act === 'settle') {
        if (!o.id) fail('position repo settle 需要 --id <逆回购编号>');
        const r = position.settleRepo({ id: o.id, account: o.account });
        log(`✔ 已结算逆回购 #${r.id}：本金 ${formatYuan(r.amountC)} + 收益 ${formatYuan(r.interestC)} 已回笼现金`);
        return;
      }
      const rs = position.listRepos(o.account, { all: !!o.all });
      log(`逆回购${o.all ? '（全部）' : '（未结算）'}: ${rs.length ? '' : '（无）'}`);
      for (const x of rs) log(`  [#${x.id}] ${x.code} ${formatYuan(x.amountC)} 元 @${x.rate}% ${x.days}天 ${x.date}→${x.dueDate} 预期收益${formatYuan(x.interestC)}${x.settled ? ' 已结算' : ''}`);
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
        log(`  ${x.code.padEnd(10)} ${(position.assetTypeOf(x.code) === 'etf' ? '[ETF]' : '     ')} ${(x.name || '').padEnd(8)} ${x.shares}股 成本${formatYuan(x.avgCost)} 现价${formatMilli(x.priceMilli, x.priceMilli % 10 === 0 ? 2 : 3)}${x.quoteMissing ? '(缺行情,按成本价)' : ''} 市值${formatYuan(x.marketValue)} 盈亏${formatYuan(x.pnl)}(${x.pnlPct}%)`);
      }
      if (r.missing?.length) log(`  ⚠ 未取到行情、按成本价计算（浮盈记为 0，非真实盈亏）: ${r.missing.join(', ')}`);
      return;
    }
    case 'summary': {
      const s = await position.summary(o.account);
      log('持仓总览:');
      log(`  持仓数 ${s.positionCount} | 本金 ${formatYuan(s.initialCapital)} | 投入成本 ${formatYuan(s.totalCostC)}`);
      log(`  证券市值 ${formatYuan(s.marketValueC)} | 现金 ${formatYuan(s.cash)} | 总资产 ${formatYuan(s.totalAssetsC)}`);
      if (s.repoCount) log(`  逆回购 ${s.repoCount} 笔 占用 ${formatYuan(s.repoPrincipalC)} | 预期收益 ${formatYuan(s.repoInterestC)} | 已结算累计收益 ${formatYuan(s.repoPnlC)}`);
      log(`  浮动盈亏 ${formatYuan(s.floatPnl)} | 已实现 ${formatYuan(s.realizedPnl)} | 合计盈亏 ${formatYuan(s.totalPnl)}`);
      if (s.missing?.length) log(`  ⚠ 未取到行情、按成本价计入市值（浮盈偏低是假象，非真实盈亏）: ${s.missing.join(', ')}`);
      return;
    }
    case 'today': {
      const t = position.dayTrades(o.date, o.account);
      log(`当日交易流水（${o.date || '今天'}）: ${t.length ? '' : '（无）'}`);
      for (const h of t) log(`  [#${h.id ?? '-'}] ${h.date}${h.time ? ' ' + h.time : ''} [${h.type}] ${h.code} ${h.name} ${h.shares}股 @${formatYuan(h.price)}${h.fee ? ` 手续费${formatYuan(h.fee)}` : ''}${h.realizedPnl != null ? ` 已实现 ${formatYuan(h.realizedPnl)}` : ''}${h.psych ? ` 心理: ${h.psych}` : ''}${h.note ? ' ' + h.note : ''}`);
      return;
    }
    case 'query': {
      return cmdPositionQuery(o);
    }
    default:
      fail('position 支持: init --capital N | add --code X --shares N --price P [--name --date --time --note --psych --fee N | --auto-fee [--account 名称]] | sell ... | psych --code X --text "..." | adjust --code X（除息复权） | cash --amount N（现金） | repo add --amount N --rate R [--days D]（逆回购）/ repo list / repo settle --id N | import --file trades.json | reset --yes | list | summary | today [--date D] | query [--code X --from D --to D --type buy|sell --only profit|loss --sort date|amount|pnl --limit N --group code|month]');
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
  // 双保险：生成的配置里任何 Key 都留空（绝不把示例文件里的值带出去）
  if (sample.fuyao) sample.fuyao.apiKey = '';
  if (sample.iwencai) sample.iwencai.apiKey = '';
  return sample;
}

/** 配置生成后的填写引导：fuyao 必填 + 问财可选（缺了就没有公告/新闻通道） */
function configFillHint() {
  log('  必填 fuyao.apiKey      —— https://fuyao.aicubes.cn 官网签发（行情/财务/复盘主链路）');
  log('  可选 iwencai.apiKey    —— https://www.iwencai.com/skillhub 获取；填好并装技能后才有「公告/新闻」通道');
  log('  Key 只写在这个文件里：不要提交到仓库、不要贴进对话');
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
    configFillHint();
    return;
  }
  if (opts.template) {
    const p = writeConfigFile(path.join(homeDir(), 'config.template.json'));
    log(`✔ 已生成模板: ${p}`);
    log(`  请参照模板自行创建 ${USER_CONFIG_PATH}`);
    configFillHint();
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
    log(`✔ 已生成: ${p}`);
    configFillHint();
  } else if (ans === false) {
    const p = writeConfigFile(path.join(homeDir(), 'config.template.json'));
    log(`✔ 已生成模板: ${p}，请参照模板自行创建 ${USER_CONFIG_PATH}`);
    configFillHint();
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
  search         --channel <通道> --q "自然语言问句" [--size N] [--summary | --raw | --save T]
                             问财渠道（17 个）：announcement 公告 / news 新闻 / report 研报 /
                             astock 选股 / market 行情 / finance 财务 / event 事件(排雷) /
                             holder 股东 / research 机构评级 / macro 宏观 / index 指数 /
                             sector 板块筛选 / industry 行业 / profile 基本资料 / business 经营 /
                             etf ETF筛选 / cb 可转债；也可直接传技能 slug
                             默认输出纯 JSON；--summary 人读摘要；--raw 网关原始 JSON；--save 落缓存

data 常用参数: --q / --thscodes / --thscode / --period annual|quarterly
  --limit / --report YYYY-N / --date / --start --end（YYYY-MM-DD 或毫秒戳）
  --interval 1d（K线必传）/ --adjust none|forward|backward / --from --to（区间日期）
  --tag cn_concept|industry / --tag-codes LIMIT_UP,SHARP_FALL（异动标签）
  --start-date --end-date（热榜走势日期）
  --board-type all|org|hot_money / --page / --size / --sort-field / --sort-dir
ETF/基金参数: --thscode 510300.SH（ETF/基金单只）
  --dump daily-k|daily-k-10d|adjustment-factors（全市场导出下载链接）
  --nav-type unit|adj|unit,adj / --range week|month|tmonth|hyear|year|twoyear|tyear|fyear
  --report-type --report-period --subscribe --manager-id --company-id
  ↑ 每个端点的必填/枚举/示例：data --kind <端点> --help

  position       init --capital N | add --code X --shares N --price P
                 [--name --date --note --psych --fee N | --auto-fee [--account 名称]]
                 [--stop 价 --target 价 --zone 低-高（计划参数，供持仓分析判定）]
                 | plan --code X [--stop S --target T --zone A-B]（给已有持仓补/改计划参数）
                 | review [--date D] [--out 路径] [--no-html] [--no-md] [--no-market] [--events 文件|JSON]
                   持仓股分析/复盘页：大盘（指数+情绪）+ 板块（领涨/领跌）+ 今日交易流水 + 持仓逐只判定
                   （默认生成单文件 HTML 报告 + 打印 Markdown 片段；判定照《复盘模板生成指南》§3）
                   --events 传风险日历（[{date,title,impact,source}]，AI 复盘时用 web 搜索补，不编造）
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
      stop: { type: 'string' }, target: { type: 'string' }, zone: { type: 'string' },
      'no-html': { type: 'boolean' }, 'no-md': { type: 'boolean' }, 'no-market': { type: 'boolean' },
      'md-file': { type: 'string' }, out: { type: 'string' }, events: { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' }, sort: { type: 'string' },
      group: { type: 'string' }, only: { type: 'string' },
      rate: { type: 'string' }, days: { type: 'string' }, id: { type: 'string' }, all: { type: 'boolean' },
      kind: { type: 'string' }, type: { type: 'string' },
      code: { type: 'string' },
      date: { type: 'string' }, 'date-ms': { type: 'string' },
      file: { type: 'string' }, data: { type: 'string' },
      'keep-days': { type: 'string' },
      save: { type: 'string' },
      q: { type: 'string' }, thscodes: { type: 'string' }, thscode: { type: 'string' },
      channel: { type: 'string' }, raw: { type: 'boolean' },
      limit: { type: 'string' }, offset: { type: 'string' }, interval: { type: 'string' },
      start: { type: 'string' }, end: { type: 'string' }, adjust: { type: 'string' },
      period: { type: 'string' }, report: { type: 'string' }, tag: { type: 'string' },
      'board-type': { type: 'string' }, page: { type: 'string' }, size: { type: 'string' },
      'sort-field': { type: 'string' }, 'sort-dir': { type: 'string' },
      stage: { type: 'string' }, exchange: { type: 'string' }, 'asset-type': { type: 'string' },
      from: { type: 'string' }, to: { type: 'string' },
      'tag-codes': { type: 'string' }, 'start-date': { type: 'string' }, 'end-date': { type: 'string' },
      dump: { type: 'string' }, 'nav-type': { type: 'string' }, range: { type: 'string' },
      'report-type': { type: 'string' }, 'report-period': { type: 'string' },
      subscribe: { type: 'string' }, 'manager-id': { type: 'string' }, 'company-id': { type: 'string' },
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
  if (cmd === 'search') return cmdSearch(values);
  log('A股助手 CLI: node src/cli.js <check|config|cache|position|data|search|investigate|daily-snapshot|help>（跑 help 看全部用法）');
  process.exitCode = 1;
}

main().catch((e) => fail(e.message));

