---
name: a-share-assistant
description: A股研究助手深度参考。当用户进行选股、个股体检、盯盘、复盘、策略验证时使用；也用于查询数据源分工、缓存协议细则、复盘报告模板。
---

# A股助手 · 深度参考

本技能是 persona 操作协议的完整补充。**persona 已含精简版协议，本文件提供流程模板、数据源细节与格式规范。**

## 第一条铁律：先体检，禁止考古

本会话首次数据任务运行 `node __PROJECT_ROOT__/src/cli.js check --quick`（`--quick` 只判断链路就绪）。**通过后本会话内复用该结果，不重复 check**——除非链路报错或 key/端点变更。`check`（不带 quick）仅在需要看端点速查/缓存索引时跑。

- **数据链路未就绪**（API Key 缺失 / 端点映射为空）：立即停止探索，向用户复述 check 输出的修复指引（补 key 或等待端点完成）。**禁止**下载官方文档、翻源码、猜接口。
- **配置缺失（CONFIG_MISSING）**：必须用 `ask_user` 询问用户"是否生成配置文件？"——同意 → `cli.js config --init`（生成后提示填写 apiKey）；拒绝 → `cli.js config --template`（告知模板路径）。禁止擅自生成、跳过或放弃。
- **数据链路就绪**：才允许取数。
- 工作目录：若 cwd 不是笔记库根目录（__NOTES_ROOT__），提示用户新建会话时选择 笔记目录；复盘笔记写入 `{{cwd}}/复盘/`，不依赖 cwd。
- **复盘**：先跑 `daily-snapshot --date D` 一次落盘当日复盘数据（涨停/跌停/炸板/连板/龙虎榜/热榜/板块/指数），再按模板生成复盘，避免逐条取数。

## 技能卫生

本助手能力只来源于本协议与技能 `a-share-assistant`。技能目录不注入（skill-quarantine 屏蔽），会话里看不到技能列表——**看到也一律不理会**。需要深度细节（交易台账/手续费/心理备注、参数速查、复盘模板、完整协议）时：用 `skill` 工具按名加载 `a-share-assistant`，或直接 `read` 文件 `__SKILL_MD__`。绝不加载、调用、推荐其他任何技能。

## 取数参数速查（链路就绪后，先看元数据再取数）

链路就绪后允许（且建议）确认参数：`node __PROJECT_ROOT__/src/cli.js data --kind <端点> --help` 输出该端点必填参数与示例；`check` 末尾也有常用参数速查。**"禁考古"只针对链路未就绪时，链路就绪后读参数元数据不算考古。**

**一键体检**：`investigate --code X [--report YYYY-N]` 一次拉齐并落盘——**自动判别标的类型**：股票=行情/财务三表/估值/异动；ETF/基金=行情/前复权日线/资料/区间收益/回撤/重仓持仓/诊断（`--report` 仅股票生效）——体检首选，比逐条 `data` 省多轮往返与 token。

| 端点类型 | 参数 | 说明 |
| :--- | :--- | :--- |
| 行情/估值/异动/竞价 | `--thscodes 600396.SH,001258.SZ` | **复数、逗号分隔**；price-snapshot 缺 `thscodes` 会返回全市场（接口不报错），务必带并核对 total |
| 财务三表 | `--thscode X --period annual\|quarterly --limit N` | period 必须是 `annual`/`quarterly`，不是年份 |
| 财务指标 | `--thscode X --report YYYY-N` | **口径对齐**：与三表取同一报告期（三表最新为 2026 H1 → indicators 用 `2026-2`），避免 Q1 指标 配 Q2 三表 |
| K线/指数历史 | `--thscode X --interval 1d --start YYYY-MM-DD --end YYYY-MM-DD` | **interval 必须显式传**（接口不认默认值，仅 1d）；日期自动转 Asia/Shanghai 毫秒；`--adjust none\|forward\|backward`（默认 forward） |
| 龙虎榜 | `--board-type all\|org\|hot_money --date YYYY-MM-DD` | date 省略取最近交易日 |
| 板块 | `--tag cn_concept\|industry` | THS 概念/行业目录 |
| **ETF/基金** | `--thscode 510300.SH`（**单只、不复数**） | ETF 行情/日线/资料/收益/净值/回撤/持仓/诊断；A股端点查 ETF 会报 `code=3004` |
| **全市场导出** | `--dump daily-k\|daily-k-10d\|adjustment-factors` | 返回 Parquet 预签名链接（5 分钟有效，**不要缓存**）；需 pyarrow 读 |

> 每个端点的必填项/枚举/示例/坑：`data --kind <端点> --help`（无需取数，最省 token 的参数确认方式）。

**Windows 备忘（仅 Windows 环境需要，Linux/macOS 忽略）**：① node 内联脚本 `import` 本地文件绝对路径必须用 `file:///` 前缀（否则 `ERR_UNSUPPORTED_ESM_URL_SCHEME`）；② pwsh 传 JSON 字符串用**单引号**（双引号内 `\"` 不是转义符）→ 写临时脚本优先单引号。

## 数据源分工（按官方文档实测，2026-08-17 建表 / 2026-09-17 扩充）

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
| **ETF 行情** | fund-market-snapshot / fund-market-historical | stock:<code>:quote / kline | 快照偶发 `code=3002`（未就绪）；日线为**前复权**、窗口≤5年；台账取价会自动兜底到最近日线收盘 |
| **ETF/基金 画像** | fund-profile / fund-returns / fund-nav / fund-drawdowns / fund-indicators-historical | stock:<code>:profile / returns / nav / drawdowns | 规模净值经理费率、近1周~近5年区间收益、净值序列、多区间最大回撤、RSI/通道/估值百分位 |
| **ETF/基金 持仓** | fund-holdings / fund-asset-allocation / fund-holders-top / fund-dividends | stock:<code>:holdings | 重仓股+行业集中度、股债配置、前十大持有人（含多期披露，按 report_date_ms 取最新）、分红记录 |
| **基金诊断** | fund-diagnostics | stock:<code>:diagnostics | 维度评分/同类对比/韧性 |
| **全市场导出** | market-dump-url（dump=daily-k/daily-k-10d/adjustment-factors） | — | Parquet 预签名链接（**5 分钟失效，禁止缓存/持久化**） |
| 新闻/公告 | **无 A 股新闻/公告接口** → 用 web 搜索兜底 | news | TTL 1h |
| 股东/质押 | **无 A 股股东接口**（仅基金有 holders） → 数据不可用 | — | 如实告知用户 |
| 主力资金/高频动向 | **外部不可用**（官方仅对同花顺AI客户端开放，实测 `code=2004`） | — | 别再试调；如实告知"该数据源当前拿不到" |
| 期货/期权/QDII/基金经理 | **未接入** | — | 本项目只做 A股 + ETF/场外基金；用户问起如实说明 |

> 问财 SkillHub CLI 在 Windows 上安装需 git-bash/WSL，v0.1 以 fuyao API 为主干；问财能力作为增强项，环境就绪后接入。取数统一走 node fetch（本机 schannel TLS 不可用）。
> **错误码对照**：`1001` 缺参 / `1002` 参数格式错（日期必须毫秒戳，CLI 已自动转）/ `1003` 越界 / `2001` key 无效 / `2003` 无权限 / `2004` 仅同花顺AI客户端可用 / `3001` 标的不存在 / `3002` 数据未就绪（ETF 快照常见，稍后重试或兜底，**不要当 0**）/ `3004` 标的类型不支持（ETF 走了股票端点）/ `4001` 限流 / `5003` 上游数据源不可用（部分基金子接口长期如此）。

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
| fund-market-snapshot | quote | ETF 实时行情 |
| fund-market-historical | kline | ETF 前复权日线 |
| fund-profile / fund-returns / fund-nav / fund-drawdowns / fund-diagnostics | profile / returns / nav / drawdowns / diagnostics | 基金画像（各存各的，勿互相覆盖） |
| fund-holdings / fund-asset-allocation / fund-holders-top / fund-dividends | holdings / allocation / holders / dividends | 基金持仓与持有人 |

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
7. **省 token**：`data` 默认输出**完整 JSON**（可被 `JSON.parse`）；只要摘要用 `--summary`（人读，不打全量）；取大数据建议 `--save` 落盘后读文件/grep，**不要全文入上下文**。

## 复盘模板

模板文件：`__PROJECT_ROOT__/templates/review-template.md`（每日复盘模板：大盘环境 / 主线与热点 / 涨停数据 / 龙虎榜 / 今日操作回顾 / 交易心理复盘 / 认知增量 / 明日计划 / 明日预测与次日回测——融资融券已去，无数据源不保留板块）。**模板内容按用户自己的模板还原，不要自行增删章节或改写措辞。**

生成复盘笔记时：**先用 `read` 读取模板**，按当天数据填充。

**AI 只填"数据可查"板块**：一~四（大盘环境、主线热点、涨停数据、龙虎榜）——用 fuyao 数据 + 网络检索填充。
**个人主观板块留空**：五~九（今日操作回顾、交易心理复盘、认知增量、明日计划、明日预测与次日回测）——这些是用户自己的交易记录/判断，**AI 不臆造、不替写**，标注"请用户填写"或留空；用户明确要求时才能给出带「AI 观点，非仓库已有」标注的草案。
输出到 `{{cwd}}/复盘/YYYY-MM-DD.md`；数据不可用的字段如实标注"暂无"，不编造。

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
node __PROJECT_ROOT__/src/cli.js position import --file trades.json   # 反向录入：批量导入历史交易，自动按净投入设初始本金
node __PROJECT_ROOT__/src/cli.js position reset --yes                # 清空台账（重建前用）
```

**精度**：所有金额/价格/手续费/盈亏内部按"分"（整数）计算，显示为两位元——无 JS 浮点误差（如 0.1+0.2 不会是 0.3000004）。
**反向录入**：用户给出"今天到之前一段交易"（`[{type:'buy'|'sell', code, shares, price, fee?, date?, time?, note?}, ...]`，`time`=成交时间 HH:MM:SS，对日内/精确对账很重要）用 `position import` 一次录齐并自动设初始本金（净投入），之后正常补记。**券商交割单**（常是 GBK 编码、Tab 分隔、伪装成 .xls，含成交日期+成交时间）可解析成该 JSON 批量导入；若期初资产为 0、交割单覆盖到某日，把"交割单全量 + 截图尾段交易"按时间合并，重放能收敛到期末持仓（实测：293 笔含时间收敛到只剩长江电力 200 股，与券商一致）。

**进阶**：
- **多账户**：`--account 名称` 隔离持仓/本金（`portfolio.<名称>.json`），费率与 `feeProfiles` 联动。
- **ETF**：与股票同法记账（代码如 `510300`）；行情自动走场内基金接口（A股快照不支持 ETF），列表标 `[ETF]`。快照未就绪（`code=3002`）时自动退回最近一根前复权日线收盘价，仍取不到则按成本价并**打印"缺行情"告警**——出现告警时必须向用户说明"浮盈为假象，非真实盈亏"。
- **现金**：`position cash --amount N` 记录现金余额。
- **逆回购**：`position repo add --amount N --rate R [--days D] [--code 204001]` 记录（年化利率%，到期收益按 `金额×利率×天数/365` 精确到分）；`repo list [--all]` 查看；`repo settle --id N` 结算（本金+收益回笼现金）。`summary` 的**总资产 = 证券市值 + 现金 + 未结算逆回购本金**。
- **除息调整**：`position adjust --code X` 按**持有期内**分红下调成本（浮盈更贴合券商；持有前分红不调）。
- **自动备份**：写入时自动存最近一份 `.bak` + `backup/` 每日快照（保留最近 30 天），任一天可回溯，防误删/损坏。
- **高级查询**：`position query [--code X --from D --to D --type buy|sell --only profit|loss --sort date|amount|pnl --limit N --group code|month]`——多维度筛选 + 统计（买入/卖出笔数金额/手续费/已实现盈亏）+ 明细 + 聚合（按标的/月度）。对账、复盘、识别亏损来源很实用。

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

### ETF / 基金体检（持有或候选标的）
1. `investigate --code 510300.SH` 一次拉齐（行情 + 前复权日线 + 资料 + 收益 + 回撤 + 持仓 + 诊断）
2. 补齐：`data --kind fund-nav --thscode X --range year`（净值曲线）、`fund-indicators-historical`（RSI/通道/估值百分位）
3. 输出：**规模与费率**（有无清盘风险/费率高低）、**跟踪与集中度**（重仓股+行业集中度）、**区间收益与最大回撤**（横向对比同类）、**持有人结构**（机构占比）、结论：**可持有/换更优标的** + 理由
4. 口径声明：持仓/持有人为**定期披露**，非实时持仓

### 离线回测取数（全市场）
1. `data --kind market-dump-url --dump daily-k`（10 年全市场日K）或 `daily-k-10d`（最近 10 交易日增量）、`adjustment-factors`（复权因子）
2. 链接 **5 分钟失效**：拉链接后立即下载，不要把 URL 写进笔记/缓存
3. Parquet 读取需 `pyarrow`；A股价格为**未复权**，复权需自行合并复权因子

### 收盘复盘
1. 快照 limit-up / dragon-tiger / sectors
2. 按模板生成 `{{cwd}}/复盘/YYYY-MM-DD.md`（插件自己的复盘目录，不绑定用户笔记库结构）
3. 提示时间戳与注意事项

