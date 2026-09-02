---
name: a-share-assistant
description: A股研究助手深度参考。当用户进行选股、个股体检、盯盘、复盘、策略验证时使用；也用于查询数据源分工、缓存协议细则、复盘报告模板。
---

# A股助手 · 深度参考

本技能是 persona 操作协议的完整补充。**persona 已含精简版协议，本文件提供流程模板、数据源细节与格式规范。**

## 第一条铁律：先体检，禁止考古

任何数据任务的第一步是运行 `node __PROJECT_ROOT__/src/cli.js check`：

- **数据链路未就绪**（API Key 缺失 / 端点映射为空）：立即停止探索，向用户复述 check 输出的修复指引（补 key 或等待端点完成）。**禁止**下载官方文档、翻源码、猜接口。
- **配置缺失（CONFIG_MISSING）**：必须用 `ask_user` 询问用户"是否生成配置文件？"——同意 → `cli.js config --init`（生成后提示填写 apiKey）；拒绝 → `cli.js config --template`（告知模板路径）。禁止擅自生成、跳过或放弃。
- **数据链路就绪**：才允许取数。
- 工作目录：若 cwd 不是笔记库根目录（__NOTES_ROOT__），提示用户新建会话时选择 笔记目录；复盘笔记写入 `{{cwd}}/复盘/`，不依赖 cwd。

## 取数参数速查（链路就绪后，先看元数据再取数）

链路就绪后允许（且建议）确认参数：`node __PROJECT_ROOT__/src/cli.js data --kind <端点> --help` 输出该端点必填参数与示例；`check` 末尾也有常用参数速查。**"禁考古"只针对链路未就绪时，链路就绪后读参数元数据不算考古。**

| 端点类型 | 参数 | 说明 |
| :--- | :--- | :--- |
| 行情/估值/异动/竞价 | `--thscodes 600396.SH,001258.SZ` | **复数、逗号分隔**；price-snapshot 缺 `thscodes` 会返回全市场（接口不报错），务必带并核对 total |
| 财务三表 | `--thscode X --period annual\|quarterly --limit N` | period 必须是 `annual`/`quarterly`，不是年份 |
| 财务指标 | `--thscode X --report YYYY-N` | **口径对齐**：与三表取同一报告期（三表最新为 2026 H1 → indicators 用 `2026-2`），避免 Q1 指标 配 Q2 三表 |
| K线/指数历史 | `--thscode X --interval 1d --start YYYY-MM-DD --end YYYY-MM-DD` | **interval 必须显式传**（接口不认默认值，仅 1d）；日期自动转 Asia/Shanghai 毫秒 |
| 龙虎榜 | `--board-type all\|org\|hot_money --date YYYY-MM-DD` | date 省略取最近交易日 |
| 板块 | `--tag cn_concept\|industry` | THS 概念/行业目录 |

**Windows 备忘（仅 Windows 环境需要，Linux/macOS 忽略）**：① node 内联脚本 `import` 本地文件绝对路径必须用 `file:///` 前缀（否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）；② pwsh 传 JSON 字符串用**单引号**（双引号内 `\"` 不是转义符）→ 写临时脚本优先单引号。

## 数据源分工（按官方文档实测，2026-08-17）

| 数据 | 来源（端点 type） | 缓存类型 | 说明 |
| :--- | :--- | :--- | :--- |
| 实时行情 | price-snapshot / valuations-snapshot | watchlist | TTL 24h；估值含 PE/PB/PS/PCF |
| 历史K线 | price-historical / adjustment-factors | stock:<code>:kline | 日线、前复权 + 复权因子事件 |
| 财务三表 | income-statements / balance-sheets / cash-flow-statements | stock:<code>:finance | 季度/年报，TTL 90天 |
| 财务指标 | financial-indicators（report=YYYY-N） | stock:<code>:finance | 成长/盈利/偿债/营运/现金流五类 |
| 涨停/连板 | limit-up-pool / limit-up-ladder | limit-up | 每日收盘快照，复盘核心 |
| 跌停/炸板 | limit-down-pool / limit-break-pool | limit-up | 情绪面 |
| 龙虎榜/游资 | dragon-tiger-list（board_type=org/hot_money） | dragon-tiger | 每日 |
| 热榜 | hot-stock-list / skyrocket-list / hot-stock-list-history / hot-stock-rank-trend | hot-stock | 题材热度（含历史/个股走势） |
| 异动原因 | anomaly-analysis-stock / anomaly-analysis-list | stock:<code>:event | 当日异动（个股+列表） |
| 标的列表 | tickers-list | — | 全量代码表（asset_type 过滤，分页） |
| 集合竞价 | auction-snapshot / short-term-benchmark | auction | 盘前情绪 |
| 板块/题材 | ths-index-list（tag=cn_concept/industry）+ index-constituents | sectors | **板块代理：THS概念/行业指数** |
| 指数行情 | index-price-snapshot / index-price-historical | index | 大盘参照 |
| 交易日历 | trading-days | — | 判断是否交易日 |
| 新闻/公告 | **无 A 股新闻/公告接口** → 用 web 搜索兜底 | news | TTL 1h |
| 股东/质押 | **无 A 股股东接口**（仅基金有） → 数据不可用 | — | 如实告知用户 |

> 问财 SkillHub CLI 在 Windows 上安装需 git-bash/WSL，v0.1 以 fuyao API 为主干；问财能力作为增强项，环境就绪后接入。取数统一走 node fetch（本机 schannel TLS 不可用）。

### 端点 kind ↔ 缓存类型映射（--kind 与 --save 是两码事）

| 取数 `--kind` | 落缓存 `--save` | 范围 |
| :--- | :--- | :--- |
| price-snapshot | quote（个股）/ watchlist（全市场） | 行情 |
| valuations-snapshot | valuations | 估值（勿与 quote 混存） |
| price-historical | kline | 历史K线 |
| income-statements / balance-sheets / cash-flow-statements | income / balance / cashflow | 三表 |
| financial-indicators | indicators | 财务指标 |
| anomaly-analysis-stock | event | 异动 |
| limit-up-pool / limit-up-ladder / limit-down-pool / limit-break-pool | limit-up | 涨跌停 |
| dragon-tiger-list | dragon-tiger | 龙虎榜 |
| hot-stock-list / skyrocket-list | hot-stock | 热榜 |
| ths-index-list | sectors | 板块 |
| index-price-snapshot / index-price-historical | index | 指数 |

## 缓存协议细则

1. **先查**：`node __PROJECT_ROOT__/src/cli.js cache latest --type <type>` — HIT 输出数据；MISS/过期输出提示。**个股缓存**用 `--code <thscode>`：`cache latest --type income --code 600396.SH`
2. **命中**：直接使用，回复中标注 `数据截至 <fetchedAt>`
3. **未命中**：取数 → `data --kind <端点> ... --save <缓存类型>` 一步完成落库
   - 全市场类快照：`--save limit-up|dragon-tiger|sectors|watchlist`
   - **个股按报表分 type**：`--save income|balance|cashflow|indicators|quote|kline|event --code 600396.SH`（各报表独立文件，禁止互相覆盖；同 type 重复写会收到覆盖告警，属正常提示）
   - 日期参数直接传 `YYYY-MM-DD`（自动转 Asia/Shanghai 毫秒）；K线用 `--start/--end`
4. **受限类型**：未知类型 TTL 兜底 24h；估值指标（PE/PB/PS）**只引用数据源原值，不自行推算市值/口径**
5. **失败降级**：脚本错误/网络不可达 → 明确告知"数据不可用"，禁止编造
6. **沙箱边界**：系统产物（配置/缓存）在会话工作目录的 `.a-share-assistant/` 下（沙箱可写范围内）；**跑 CLI 时必须用会话工作目录作为 workdir**，cwd 不对时先提示用户新建会话选择正确目录

## 复盘模板

模板文件：`__PROJECT_ROOT__/templates/review-template.md`（每日复盘模板，九大板块：大盘环境 / 主线热点 / 涨停数据 / 资金面 / 龙虎榜 / 操作回顾 / 交易心理 / 认知增量 / 明日计划）。

生成复盘笔记时：**先用 `read` 读取模板**，按当天数据填充。

**AI 只填"数据可查"板块**：一~五（大盘环境、主线热点、涨停数据、资金面、龙虎榜）——用 fuyao 数据 + 网络检索填充。
**个人主观板块留空**：六~九（操作回顾、交易心理、认知增量、明日计划+铁律）——这些是用户自己的交易记录/判断，**AI 不臆造、不替写**，标注"请用户填写"或留空。
输出到 `{{cwd}}/复盘/YYYY-MM-DD.md`；数据不可用的板块如实标注"暂无"，不编造。

## 交易台账（position）

记录本金、建仓、加仓、减仓/清仓；数据存 `{{cwd}}/.a-share-assistant/portfolio.json`（**个人财务数据，敏感，git 忽略**）。

```bash
node __PROJECT_ROOT__/src/cli.js position init --capital 200000     # 设初始本金
node __PROJECT_ROOT__/src/cli.js position add --code 600519.SH --name 贵州茅台 --shares 100 --price 1500 --date 2026-09-01 --note "计划内的主线" --fee 30
node __PROJECT_ROOT__/src/cli.js position add --code 601318.SH --shares 200 --price 60 --auto-fee --account 券商A   # 自动按账户费率估算
node __PROJECT_ROOT__/src/cli.js position sell --code 600519.SH --shares 50 --price 1550 --auto-fee   # 减仓/清仓（自动算已实现盈亏）
node __PROJECT_ROOT__/src/cli.js position list      # 持仓 + 现价/市值/浮盈（拉行情）
node __PROJECT_ROOT__/src/cli.js position summary   # 本金/市值/盈亏总览
node __PROJECT_ROOT__/src/cli.js position today     # 当日交易流水
```

**手续费**：`--fee` 记录交易手续费——买入计入持仓成本、卖出从已实现盈亏扣除；不填则按 0。
**自动费率**：`--auto-fee` 按配置里的 `feeProfiles` 自动估算（默认：佣金万2.5、最低5元、印花税0.05%卖出、过户费0.001%双向）。**多账户**：在 `.a-share-assistant/config.json` 的 `feeProfiles` 加多个费率（如 `"券商A": {...}`、`"券商B": {...}`），用 `--account 券商A` 切换；`default` 为缺省。
**对话记账**：用户说「我建仓了茅台 100 股 1500」「加了 50 股 1520」「今天卖了 50 股 1550」「我的本金是 20 万」「今天交易了啥」——AI 用 `position add/sell/init/today` 记录/查询，勿让用户手动抄。
**交易心理备注**：给每笔交易做心理复盘——`add/sell` 时用 `--psych "计划内/冲动追高"`；对已有交易 `position psych --code X --text "复盘：这笔是FOMO追高" [--date D]`。复盘"操作回顾/交易心理"板块引用这些备注，帮用户对账"当时为什么这么操作"。
**复盘接入**：复盘"操作回顾"板块从 `position today` 当日流水自动引用（含建仓/卖出与已实现盈亏），用户再补充盈亏感受即可。

## 常见任务模板

### 盘前找方向
1. 取 sectors（板块）、news（新闻）缓存，不足则取数
2. 输出：今日题材方向 + 相关个股线索

### 个股体检（一票否决制）
1. 财务（营收/净利/ROE/现金流）
2. 事件（质押/解禁/业绩预告/减持）
3. 股东（户数变化/十大流通股东）
4. 公告与新闻
5. 输出结论：**通过/否决** + 理由清单

### 收盘复盘
1. 快照 limit-up / dragon-tiger / sectors
2. 按模板生成 `{{cwd}}/复盘/YYYY-MM-DD.md`（插件自己的复盘目录，不绑定用户笔记库结构）
3. 提示时间戳与注意事项

