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

async function cmdCheck() {
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
  log('-- 缓存索引 --');
  const st = cache.status();
  log(`磁盘占用: ${st.sizeHuman}`);
  if (st.rows.length === 0) log('（暂无缓存数据，先跑 snapshot）');
  for (const r of st.rows) {
    log(`  ${r.label.padEnd(10)} 最新=${r.latest} 拉取=${r.fetchedAt} ${r.state}`);
  }
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
  console.log(JSON.stringify(result, null, 2));
}

// ── 交易台账：node cli.js position <init|add|buy|sell|list|summary|today> ──
async function cmdPosition(argv) {
  const sub = argv._[0];
  const o = argv.values;
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
  switch (sub) {
    case 'init': {
      const c = num(o.capital);
      if (!Number.isFinite(c) || c <= 0) fail('position init 需要 --capital <初始本金（正数）>');
      log(`✔ 初始本金已设: ${position.setCapital(c)}`);
      return;
    }
    case 'add':
    case 'buy': {
      if (!o.code) fail('position add 需要 --code <代码，如 600519.SH>');
      const s = num(o.shares), pr = num(o.price);
      if (!Number.isFinite(s) || !Number.isFinite(pr)) fail('position add 需要 --shares <股数> 与 --price <价格>');
      let feeVal = num(o.fee);
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = position.estimateFee({ side: 'buy', shares: s, price: pr, account: o.account });
      const pos = position.addPosition({ code: o.code, name: o.name, shares: s, price: pr, date: o.date, note: o.note, psych: o.psych, fee: feeVal });
      log(`✔ 已记录建仓/加仓: ${pos.code} ${pos.name} 现持仓 ${pos.shares} 股，均价 ${pos.avgCost}${feeVal ? `（手续费${feeVal}）` : ''}${pos.psych ? '（心理备注: ' + pos.psych + '）' : ''}`);
      return;
    }
    case 'sell': {
      if (!o.code) fail('position sell 需要 --code');
      const s = num(o.shares), pr = num(o.price);
      if (!Number.isFinite(s) || !Number.isFinite(pr)) fail('position sell 需要 --shares 与 --price');
      let feeVal = num(o.fee);
      if (!Number.isFinite(feeVal) && o['auto-fee']) feeVal = position.estimateFee({ side: 'sell', shares: s, price: pr, account: o.account });
      const r = position.sellPosition({ code: o.code, shares: s, price: pr, date: o.date, note: o.note, psych: o.psych, fee: feeVal });
      log(`✔ 已卖出 ${r.code} ${s} 股，已实现盈亏 ${r.realizedPnl}${r.closed ? '（已清仓）' : ''}${feeVal ? `（手续费${feeVal}）` : ''}${o.psych ? '（心理备注: ' + o.psych + '）' : ''}`);
      return;
    }
    case 'psych': {
      if (!o.code || !o.text) fail('position psych 需要 --code 与 --text <心理备注>');
      const r = position.addPsychNote({ code: o.code, date: o.date, text: o.text });
      log(`✔ 已为交易 #${r.id}（${r.code} ${r.shares}股 @${r.price} ${r.date}）添加心理备注: ${r.psych}`);
      return;
    }
    case 'list': {
      const r = await position.listPositions();
      log(`持仓列表（初始本金 ${r.initialCapital}）:`);
      if (!r.rows.length) { log('  （暂无持仓，用 position add 建仓）'); return; }
      for (const x of r.rows) {
        log(`  ${x.code.padEnd(10)} ${(x.name || '').padEnd(8)} ${x.shares}股 成本${x.avgCost} 现价${x.price} 市值${x.marketValue} 盈亏${x.pnl}(${x.pnlPct}%)`);
      }
      return;
    }
    case 'summary': {
      const s = await position.summary();
      log('持仓总览:');
      log(`  持仓数 ${s.positionCount} | 本金 ${s.initialCapital} | 投入成本 ${s.totalCost}`);
      log(`  市值 ${s.marketValue} | 浮动盈亏 ${s.floatPnl} | 已实现 ${s.realizedPnl} | 合计 ${s.totalPnl}`);
      return;
    }
    case 'today': {
      const t = position.dayTrades(o.date);
      log(`当日交易流水（${o.date || '今天'}）: ${t.length ? '' : '（无）'}`);
      for (const h of t) log(`  [#${h.id ?? '-'}] [${h.type}] ${h.code} ${h.name} ${h.shares}股 @${h.price}${h.fee ? ` 手续费${h.fee}` : ''}${h.realizedPnl != null ? ` 已实现 ${h.realizedPnl}` : ''}${h.psych ? ` 心理: ${h.psych}` : ''}${h.note ? ' ' + h.note : ''}`);
      return;
    }
    default:
      fail('position 支持: init --capital N | add --code X --shares N --price P [--name --date --note --psych] | sell --code X --shares N --price P [--date --note --psych] | psych --code X --text "心理备注" [--date D] | list | summary | today [--date D]');
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
  data           --kind K [参数] [--save T [--code X] [--date D]]
                            取数并可选落缓存（--save 指定缓存类型；--code 存个股级）

data 常用参数: --q / --thscodes / --thscode / --period annual|quarterly
  --limit / --report YYYY-N / --date / --start --end（YYYY-MM-DD 或毫秒戳）
  --board-type all|org|hot_money / --page / --size / --tag cn_concept|industry

  position       init --capital N | add --code X --shares N --price P
                 [--name --date --note --psych --fee N | --auto-fee [--account 名称]]
                 | sell --code X --shares N --price P [--date --psych --fee|--auto-fee]
                 | psych --code X --text "..." [--date D] | list | summary | today [--date D]
position 参数: --fee 手续费（买入计入成本/卖出从已实现盈亏扣）；--auto-fee 按费率自动估算；
  --account <账户> 用配置 feeProfiles 的对应费率（多账户）；--psych 心理备注；--name 名称

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
      help: { type: 'boolean' },
      capital: { type: 'string' }, name: { type: 'string' }, shares: { type: 'string' },
      price: { type: 'string' }, note: { type: 'string' }, psych: { type: 'string' }, text: { type: 'string' }, fee: { type: 'string' },
      'auto-fee': { type: 'boolean' }, account: { type: 'string' },
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
  if (cmd === 'check') return cmdCheck();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return cmdHelp();
  if (cmd === 'config') return cmdConfig(values);
  if (cmd === 'cache') return cmdCache({ _: positionals.slice(1), values });
  if (cmd === 'position') return cmdPosition({ _: positionals.slice(1), values });
  if (cmd === 'data') return cmdData(values);
  log('A股助手 CLI: node src/cli.js <check|config|cache|position|data|help>（跑 help 看全部用法）');
  process.exitCode = 1;
}

main().catch((e) => fail(e.message));

