// fuyao 数据源客户端：统一走 node fetch（本机 schannel SSL 只有 Node 能连通）
import { FUYAO_BASE, getApiKey, getConfigSource } from './config.js';

const TIMEOUT_MS = 15000;

export async function fetchJson(url, { headers = {}, timeoutMs = TIMEOUT_MS, method = 'GET' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', ...headers },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
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

// ── 端点映射（已按官方文档 /docs/api-reference/ 填写，2026-08-17 确认）────────
// 所有端点 GET + X-api-key；params.required 用于必填预检（报错带示例命令）
export const ENDPOINTS = {
  'ticker-search': {
    path: '/api/meta/tickers/search', note: '标的检索（名称模糊/代码精确）',
    params: { required: ['q'], example: '--kind ticker-search --q 华电辽能 --limit 5' },
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
  'skyrocket-list': {
    path: '/api/a-share/special-data/skyrocket-list', note: '飙升榜',
    params: { required: [], example: '--kind skyrocket-list' },
  },
  'anomaly-analysis-stock': {
    path: '/api/a-share/special-data/anomaly-analysis-stock', note: '个股异动原因',
    params: { required: ['thscodes'], example: '--kind anomaly-analysis-stock --thscodes 600396.SH' },
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
};

/** 常见业务错误码 → 中文修复指引 */
export const ERROR_CODE_HINTS = {
  1001: '缺少必填参数（按示例补全后重试；K线端点须显式传 --interval 1d）',
  1002: '参数取值非法。若报 Unknown thscode，说明该代码无效/不存在——先用 ticker-search 检索确认，或检查指数/板块代码后缀（.SH/.SZ/.TI 等）；若是非交易日/枚举值错误，检查参数',
  1003: '参数超出允许范围（如窗口超 10 年、limit 超上限）',
};

/**
 * 通用取数：getData('price-snapshot', { thscodes: '600396.SH' })
 * 必填参数预检：缺失时抛出带示例命令的错误（杜绝静默返回全市场等行为）。
 */
export async function getData(kind, params = {}) {
  const spec = ENDPOINTS[kind];
  if (!spec) {
    throw new Error(
      `端点 ${kind} 未配置。可用端点: ${Object.keys(ENDPOINTS).join(', ')}`
    );
  }
  const required = spec.params?.required ?? [];
  const missing = required.filter((r) => params[r] === undefined || params[r] === null || params[r] === '');
  if (missing.length > 0) {
    throw new Error(
      `端点 ${kind} 缺少必填参数: ${missing.join(', ')}。示例命令: ${spec.params?.example || spec.path}`
    );
  }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  const url = `${FUYAO_BASE}${spec.path}${q ? '?' + q : ''}`;
  return fetchJson(url, { method: 'GET', headers: authHeaders() });
}