// fuyao 数据源客户端：统一走 node fetch（本机 schannel SSL 只有 Node 能连通）
import { FUYAO_BASE, getApiKey, getConfigSource } from './config.js';

const TIMEOUT_MS = 15000;

export async function fetchJson(url, { headers = {}, timeoutMs = TIMEOUT_MS, method = 'GET', maxRetry = 2, retryDelayMs = 300 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetry; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
      });
      if (res.ok) {
        const text = await res.text();
        try { return JSON.parse(text); } catch { return text; }
      }
      throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
    } catch (e) {
      lastErr = e;
      if (attempt < maxRetry) await new Promise((r) => setTimeout(r, retryDelayMs * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/** 连通性检测：能调通 fuyao 站点即视为网络可用 */
export async function ping() {
  const t0 = Date.now();
  const res = await fetch(`${FUYAO_BASE}/llms.txt`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return { ok: res.ok, status: res.status, ms: Date.now() - t0, base: FUYAO_BASE };
}

/** 带 key 的 API 请求；无 key 时抛出明确错误 */
export function authHeaders() {
  const key = getApiKey();
  if (!key) {
    throw new Error(
      '未配置 fuyao API Key。请在会话目录 .a-share-assistant/config.json 的 fuyao.apiKey 或环境变量 FUYAO_API_KEY 中填写（在 https://fuyao.aicubes.cn 签发），然后重试。'
    );
  }
  return { 'X-api-key': key };
}

/**
 * 全市场行情快照（约 5500 只、1.2 MB）：**只在需要「全市场涨跌家数」这类聚合统计时调用**。
 * 刻意绕过 getData 的 thscodes 必填预检——那道护栏是防止误把全市场明细灌进上下文的；
 * 调用方**必须只取聚合结果**，不得把 item 整体打印或塞进上下文（实测 308ms / 5575 只）。
 */
export async function fetchAllMarketSnapshot() {
  const url = `${FUYAO_BASE}${ENDPOINTS['price-snapshot'].path}`;
  return fetchJson(url, { method: 'GET', headers: authHeaders() });
}

/** 数据链路体检：key 是否就绪 + 端点表是否已配置 + 最小接口试调 */
export async function dataLinkProbe() {
  const key = getApiKey();
  const keyOk = Boolean(key);
  const endpointsCount = Object.keys(ENDPOINTS).length;
  let probe = { ok: false, detail: '未配置端点映射，无法试调' };
  if (keyOk && endpointsCount > 0) {
    try {
      const first = Object.entries(ENDPOINTS)[0];
      const res = await fetch(`${FUYAO_BASE}${first[1].path}`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      probe = { ok: res.ok, detail: `${first[0]} -> HTTP ${res.status}` };
    } catch (e) {
      probe = { ok: false, detail: `试调失败: ${e.message}` };
    }
  }
  return { keyOk, apiKeySource: key ? (process.env.FUYAO_API_KEY || process.env.A_SHARE_API_KEY ? '环境变量' : getConfigSource()) : null, endpointsCount, probe };
}

// ── 端点映射（已按官方文档 /docs/api-reference/ 填写）───────────────────────
// 2026-08-17 建表；2026-09-17 按官方新增能力扩充（ETF/基金 12 项 + 全市场导出）
// 所有端点 GET + X-api-key；params.required 用于必填预检（报错带示例命令）
// params.enum 用于枚举校验；spec.blocked 标记「官方已上线但外部 Key 不可用」
// path 支持 {name} 占位符（占位参数不进 query string）
export const ENDPOINTS = {
  'ticker-search': {
    path: '/api/meta/tickers/search', note: '标的检索（名称模糊/代码精确）',
    params: { required: ['q'], example: '--kind ticker-search --q 华电辽能 --limit 5' },
  },
  'tickers-list': {
    path: '/api/meta/tickers/list', note: '标的列表/代码表（分页，asset_type 过滤）',
    params: { required: [], example: '--kind tickers-list --asset-type a-share --limit 1000 --offset 0' },
  },
  'price-snapshot': {
    path: '/api/a-share/prices/snapshot', note: 'A股行情快照(实时)',
    params: { required: ['thscodes'], example: '--kind price-snapshot --thscodes 600396.SH,001258.SZ', warn: '缺 thscodes 会返回全市场数据，个股行情务必带 --thscodes 并核对 total' },
  },
  'price-historical': {
    path: '/api/a-share/prices/historical', note: 'A股历史K线(日线)',
    params: { required: ['thscode', 'interval', 'start', 'end'], example: '--kind price-historical --thscode 600396.SH --interval 1d --start 2026-08-01 --end 2026-08-17', warn: 'interval 必须显式传（接口不认默认值），当前仅支持 1d' },
  },
  'income-statements': {
    path: '/api/a-share/financials/income-statements', note: '利润表',
    params: { required: ['thscode'], example: '--kind income-statements --thscode 600396.SH --period quarterly --limit 4' },
  },
  'balance-sheets': {
    path: '/api/a-share/financials/balance-sheets', note: '资产负债表',
    params: { required: ['thscode'], example: '--kind balance-sheets --thscode 600396.SH --period quarterly --limit 4' },
  },
  'cash-flow-statements': {
    path: '/api/a-share/financials/cash-flow-statements', note: '现金流量表',
    params: { required: ['thscode'], example: '--kind cash-flow-statements --thscode 600396.SH --period quarterly --limit 4' },
  },
  'financial-indicators': {
    path: '/api/a-share/financials/indicators', note: '财务指标(五能力)',
    params: { required: ['thscode', 'report'], example: '--kind financial-indicators --thscode 600396.SH --report 2026-2', warn: 'report 须与三表报告期对齐（如三表最新为 H1 则用 2026-2）' },
  },
  'limit-up-pool': {
    path: '/api/a-share/special-data/limit-up-pool', note: '涨停池',
    params: { required: [], example: '--kind limit-up-pool --page 1 --size 50 --sort-field limit_up_time' },
  },
  'limit-down-pool': {
    path: '/api/a-share/special-data/limit-down-pool', note: '跌停池',
    params: { required: [], example: '--kind limit-down-pool --page 1 --size 50' },
  },
  'limit-break-pool': {
    path: '/api/a-share/special-data/limit-break-pool', note: '炸板池',
    params: { required: [], example: '--kind limit-break-pool --page 1 --size 50' },
  },
  'limit-up-ladder': {
    path: '/api/a-share/special-data/limit-up-ladder', note: '连板天梯(近30交易日)',
    params: { required: [], example: '--kind limit-up-ladder' },
  },
  'dragon-tiger-list': {
    path: '/api/a-share/special-data/dragon-tiger-list', note: '龙虎榜(机构/游资)',
    params: { required: [], example: '--kind dragon-tiger-list --board-type hot_money --date 2026-08-14' },
  },
  'hot-stock-list': {
    path: '/api/a-share/special-data/hot-stock-list', note: 'A股热股榜 Top30',
    params: { required: [], example: '--kind hot-stock-list --period day' },
  },
  'hot-stock-list-history': {
    path: '/api/a-share/special-data/hot-stock-list-history', note: '历史热股排行（按自然日）',
    params: { required: ['date'], example: '--kind hot-stock-list-history --date 2026-08-17', warn: 'date 只支持一年内数据' },
  },
  'hot-stock-rank-trend': {
    path: '/api/a-share/special-data/hot-stock-rank-trend', note: '个股热榜排名走势',
    params: { required: ['thscode', 'start_date', 'end_date'], example: '--kind hot-stock-rank-trend --thscode 300034.SZ --start-date 2026-06-21 --end-date 2026-07-01' },
  },
  'skyrocket-list': {
    path: '/api/a-share/special-data/skyrocket-list', note: '飙升榜',
    params: { required: [], example: '--kind skyrocket-list' },
  },
  'anomaly-analysis-stock': {
    path: '/api/a-share/special-data/anomaly-analysis-stock', note: '个股异动原因',
    params: { required: ['thscodes'], example: '--kind anomaly-analysis-stock --thscodes 600396.SH' },
  },
  'anomaly-analysis-list': {
    path: '/api/a-share/special-data/anomaly-analysis-list', note: '当日个股异动原因列表（可按标签过滤）',
    params: { required: [], example: '--kind anomaly-analysis-list --tag-codes LIMIT_UP,SHARP_FALL', warn: 'tag_codes 合法值: LIMIT_UP/LIMIT_DOWN/SHARP_RISE/SHARP_FALL/RAPID_RALLY/RAPID_DECLINE' },
  },
  'adjustment-factors': {
    path: '/api/a-share/corporate-actions/adjustment-factors', note: '复权因子事件流（单只标的）',
    params: { required: ['thscode'], example: '--kind adjustment-factors --thscode 600396.SH --from 2026-08-01 --to 2026-08-17' },
  },
  'auction-snapshot': {
    path: '/api/a-share/auction/snapshot', note: 'A股集合竞价快照',
    params: { required: ['thscodes'], example: '--kind auction-snapshot --thscodes 600396.SH --stage final' },
  },
  'short-term-benchmark': {
    path: '/api/a-share/auction/short-term-benchmark', note: '短线风向标竞价基准',
    params: { required: [], example: '--kind short-term-benchmark' },
  },
  'valuations-snapshot': {
    path: '/api/a-share/valuations/snapshot', note: 'A股估值快照(PE/PB/PS/PCF)',
    params: { required: ['thscodes'], example: '--kind valuations-snapshot --thscodes 600396.SH,001258.SZ' },
  },
  'trading-days': {
    path: '/api/a-share/calendar/trading-days', note: 'A股交易日历',
    params: { required: [], example: '--kind trading-days' },
  },
  'ths-index-list': {
    path: '/api/a-share-index/catalog/ths-index-list', note: 'THS指数/概念/行业目录(板块代理)',
    params: { required: [], example: '--kind ths-index-list --tag cn_concept' },
  },
  'index-constituents': {
    path: '/api/a-share-index/constituents/ths-stock-list', note: 'THS指数成分股',
    params: { required: [], example: '--kind index-constituents --tag cn_concept' },
  },
  'index-price-snapshot': {
    path: '/api/a-share-index/prices/snapshot', note: '指数行情快照',
    params: { required: ['thscodes'], example: '--kind index-price-snapshot --thscodes 000001.SH' },
  },
  'index-price-historical': {
    path: '/api/a-share-index/prices/historical', note: '指数历史K线',
    params: { required: ['thscode', 'interval', 'start', 'end'], example: '--kind index-price-historical --thscode 000001.SH --interval 1d --start 2026-08-01 --end 2026-08-17', warn: 'interval 必须显式传，当前仅支持 1d' },
  },
  // ── ETF / 场内基金（A股快照与三表都不支持 ETF，走 fund/* ）──────────────
  // ETF 行情：A股 price-snapshot 不支持 ETF，场内基金走此端点（仅 ETF，单只）
  'fund-market-snapshot': {
    path: '/api/fund/market/snapshot', note: '场内基金(ETF)行情快照',
    params: { required: ['thscode'], example: '--kind fund-market-snapshot --thscode 510300.SH', warn: '仅支持 ETF；A股行情请用 price-snapshot；偶发 code=3002(数据未就绪) 属上游未就绪，稍后重试' },
  },
  'fund-market-historical': {
    path: '/api/fund/market/historical', note: 'ETF 历史日线（前复权）',
    params: { required: ['thscode', 'start', 'end'], example: '--kind fund-market-historical --thscode 510300.SH --interval 1d --start 2026-08-01 --end 2026-09-17', warn: '仅 ETF；单只、窗口最长 5 个自然年；价格恒为前复权（响应 adjust 固定 null 不代表未复权）' },
  },
  'fund-profile': {
    path: '/api/fund/profile/detail', note: '基金/ETF 基本资料（规模/净值/经理/费率）',
    params: { required: ['thscode'], example: '--kind fund-profile --thscode 510300.SH' },
  },
  'fund-returns': {
    path: '/api/fund/performance/returns', note: '基金/ETF 区间收益（近1周~近5年/今年/成立以来）',
    params: { required: ['thscode'], example: '--kind fund-returns --thscode 510300.SH' },
  },
  'fund-nav': {
    path: '/api/fund/performance/nav', note: '基金净值序列（单位净值/复权净值）',
    params: { required: ['thscode'], example: '--kind fund-nav --thscode 510300.SH --range month --nav-type unit', warn: 'range 取 week|month|tmonth|hyear|year|twoyear|tyear|fyear（省略只返回最新一条）；nav_type 取 unit|adj|unit,adj' },
  },
  'fund-drawdowns': {
    path: '/api/fund/performance/drawdowns', note: '基金/ETF 最大回撤（多区间）',
    params: { required: ['thscode'], example: '--kind fund-drawdowns --thscode 510300.SH' },
  },
  'fund-indicators-historical': {
    path: '/api/fund/performance/indicators-historical', note: '基金历史业绩指标（RSI/通道/估值百分位）',
    params: { required: ['thscode', 'start', 'end'], example: '--kind fund-indicators-historical --thscode 510300.SH --start 2026-08-01 --end 2026-09-17' },
  },
  'fund-holdings': {
    path: '/api/fund/portfolio/holdings', note: '基金重仓持仓（股票/债券+行业集中度）',
    params: { required: ['thscode'], example: '--kind fund-holdings --thscode 510300.SH', warn: '定期披露口径，不是实时持仓' },
  },
  'fund-asset-allocation': {
    path: '/api/fund/portfolio/asset-allocation', note: '基金资产配置（股/债/存款/其他）',
    params: { required: ['thscode'], example: '--kind fund-asset-allocation --thscode 510300.SH' },
  },
  'fund-diagnostics': {
    path: '/api/fund/diagnostics/detail', note: '基金诊断（维度评分/同类对比/韧性）',
    params: { required: ['thscode'], example: '--kind fund-diagnostics --thscode 510300.SH' },
  },
  'fund-holders-top': {
    path: '/api/fund/holders/top', note: '基金前十大持有人',
    params: { required: ['thscode'], example: '--kind fund-holders-top --thscode 510300.SH --limit 10', warn: '实测 limit 不裁剪返回条数（含多期披露，可能上百条）；用 report_date_ms 取最新一期' },
  },
  'fund-dividends': {
    path: '/api/fund/corporate-actions/dividends', note: '基金分红记录（权益登记/分红总额）',
    params: { required: ['thscode'], example: '--kind fund-dividends --thscode 510300.SH' },
  },

  // ── 全市场数据导出（Parquet 预签名下载链接，URL 约 5 分钟失效）──────────
  'market-dump-url': {
    path: '/api/dump/market-dumps/{dump}/download-url', note: '全市场数据导出下载链接（10年日K / 最近10交易日 / 复权因子）',
    params: {
      required: ['dump'],
      enum: { dump: ['daily-k', 'daily-k-10d', 'adjustment-factors'] },
      example: '--kind market-dump-url --dump daily-k-10d',
      warn: '返回 S3 预签名链接（5 分钟失效，勿缓存）；文件为 Parquet，需 pyarrow 读取',
    },
  },

  // ── 官方文档已有、但外部 API Key 暂不可用（实测 code=2004，同花顺AI客户端专用）──
  // 列出是为了「快速失败 + 明确告知」，避免 AI 反复试调浪费往返
  'capital-flow-snapshot': {
    path: '/api/a-share/capital-flow/snapshot', note: '主力资金实时快照（外部暂不可用）',
    blocked: '官方已上线但仅对同花顺AI客户端开放，API Key 调用返回 code=2004',
  },
  'capital-flow-historical': {
    path: '/api/a-share/capital-flow/historical', note: '主力资金历史（外部暂不可用）',
    blocked: '官方已上线但仅对同花顺AI客户端开放，API Key 调用返回 code=2004',
  },
  'high-frequency-intraday': {
    path: '/api/a-share/high-frequency/intraday', note: '高频单日分时（外部暂不可用）',
    blocked: '官方已上线但仅对同花顺AI客户端开放，API Key 调用返回 code=2004',
  },
  'high-frequency-historical': {
    path: '/api/a-share/high-frequency/historical', note: '高频历史（外部暂不可用）',
    blocked: '官方已上线但仅对同花顺AI客户端开放，API Key 调用返回 code=2004',
  },
};

/** 常见业务错误码 → 中文修复指引 */
export const ERROR_CODE_HINTS = {
  1001: '缺少必填参数（按示例补全后重试；K线端点须显式传 --interval 1d）',
  1002: '参数取值非法。若报 Unknown thscode，说明该代码无效/不存在——先用 ticker-search 检索确认，或检查指数/板块代码后缀（.SH/.SZ/.TI 等）；若是非交易日/枚举值错误，检查参数',
  1003: '参数超出允许范围（如窗口超 10 年、limit 超上限）',
  1004: '参数冲突（如 financials 同时传 start/end 与 limit，或只传了 start/end 之一）',
  2001: '未认证：API Key 缺失或无效——检查 .a-share-assistant/config.json 的 fuyao.apiKey',
  2003: '权限不足：当前 Key 无权调用该 capability（换端点或找官方开通）',
  2004: '该数据为同花顺AI客户端专用，外部 API Key 不可用（主力资金/高频动向等）——不要再重试，直接告知用户该数据源不可用',
  3001: '标的不存在：核对该 thscode（先 ticker-search）',
  3002: '数据未就绪：标的存在但当前无可用数据（ETF 行情易在收盘结算/停牌时出现）——稍后重试或改用成本价，不要当成 0',
  3004: '标的类型不支持该能力（如用 A股 price-snapshot 查 ETF、用财务三表查基金）——改用对应 fund-* 端点',
  4001: '触发限流：降低并发/频率，稍后重试',
  5001: '服务内部错误，可重试',
  5002: '上游服务超时，可重试',
  5003: '上游数据源不可用（部分基金子接口长期返回 5003）——如实告知用户该数据暂不可取',
};

/** 日期归一化：`YYYY-MM-DD` → Asia/Shanghai 当日零点的毫秒戳（接口只认毫秒戳）；其余原样返回 */
export function toMsTimestamp(value) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
    return String(Date.parse(`${value}T00:00:00+08:00`));
  }
  return value;
}

/**
 * 通用取数：getData('price-snapshot', { thscodes: '600396.SH' })
 * 必填参数预检：缺失时抛出带示例命令的错误（杜绝静默返回全市场等行为）。
 * 支持路径占位符（如 /api/dump/market-dumps/{dump}/download-url）与枚举校验；
 * start/end 传 `YYYY-MM-DD` 会自动转毫秒戳（接口不认日期字符串，实测 code=1002）。
 */
export async function getData(kind, params = {}) {
  const spec = ENDPOINTS[kind];
  if (!spec) {
    throw new Error(
      `端点 ${kind} 未配置。可用端点: ${Object.keys(ENDPOINTS).join(', ')}`
    );
  }
  if (spec.blocked) {
    throw new Error(`端点 ${kind}（${spec.note}）外部不可用：${spec.blocked}。不要重试，如实告知用户该数据源不可用。`);
  }
  const p = { ...params };
  for (const k of ['start', 'end']) {
    if (p[k] !== undefined && p[k] !== null && p[k] !== '') p[k] = toMsTimestamp(p[k]);
  }
  const required = spec.params?.required ?? [];
  const missing = required.filter((r) => p[r] === undefined || p[r] === null || p[r] === '');
  if (missing.length > 0) {
    throw new Error(
      `端点 ${kind} 缺少必填参数: ${missing.join(', ')}。示例命令: ${spec.params?.example || spec.path}`
    );
  }
  // 枚举校验：取值写错时直接报合法值，省一轮往返
  for (const [name, allowed] of Object.entries(spec.params?.enum ?? {})) {
    const v = p[name];
    if (v !== undefined && v !== null && v !== '' && !allowed.includes(String(v))) {
      throw new Error(`端点 ${kind} 的 ${name} 取值非法: ${v}。合法值: ${allowed.join(' | ')}`);
    }
  }
  // 路径占位符替换（占位参数不进 query string）
  const usedInPath = new Set();
  const path = spec.path.replace(/\{(\w+)\}/g, (_, name) => {
    usedInPath.add(name);
    return encodeURIComponent(String(p[name]));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (usedInPath.has(k)) continue;
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  const url = `${FUYAO_BASE}${path}${q ? '?' + q : ''}`;
  return fetchJson(url, { method: 'GET', headers: authHeaders() });
}