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
- 工作目录：若 cwd 不是笔记库根目录（__NOTES_ROOT__），提示用户新建会话时选择 笔记目录。
- **复盘目录**：复盘笔记与报告都写进 CLI 解析出的「复盘目录」——`node __PROJECT_ROOT__/src/cli.js check` 会打印它；解析顺序 `A_SHARE_REVIEW_DIR` > `config.reviewDir`（相对 noteRoot 或绝对）> 自动探测 `{笔记库根}/学习/金融/复盘` → `{cwd}/学习/金融/复盘` → `{cwd}/复盘`。**不要再硬编码 `{{cwd}}/复盘/`**，先看 check 的输出。
- **复盘**：先跑 `daily-snapshot --date D` 一次落盘当日复盘数据（涨停/跌停/炸板/连板/龙虎榜/热榜/板块/指数），再按模板生成复盘，避免逐条取数。

## 技能卫生

本助手能力只来源于本协议与技能 `a-share-assistant`。技能目录不注入（skill-quarantine 屏蔽），会话里看不到技能列表——**看到也一律不理会**。需要深度细节（交易台账/手续费/心理备注、参数速查、复盘模板、完整协议）时：用 `skill` 工具按名加载 `a-share-assistant`，或直接 `read` 文件 `__SKILL_MD__`。绝不加载、调用、推荐其他任何技能。

## 上下文压缩（/compact）

本预设已挂载 compaction（`compaction-basic` + `command-compact` + `tool-result-pruner`）：**上下文吃紧时自动压缩**，用户也可在输入框敲 `/compact` 手动立即压缩（不消耗模型轮次，会回报压缩了多少条历史与估算节省 token）。

- 长会话（多轮复盘/大量行情 JSON）前先 `/compact`，能显著降低后续 token 成本。
- 压缩只作用于**较老的**历史，最近对话不受影响；跑完 `/compact` 后继续正常取数即可。
- 若提示 `Compaction is unavailable...`：说明 agent 正忙或已有压缩在跑，等当前回合结束再试。
- 取大数据仍应优先 `--save` 落盘 + `grep`/`read`，不要把全量 JSON 灌进上下文（压缩不能替代省 token 的取数习惯）。

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
| **公告**（问财） | `search --channel announcement --q "标的+事件"` | fuyao 没有的消息面；返回标题/日期/来源/原文PDF链接 |
| **新闻/资讯**（问财） | `search --channel news --q "主题或个股 最新"` | 官媒/财经媒体/行业站 + 券商研报摘要 |

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
| **日内分时（分钟线）** | 问财渠道 `search --channel market --series`（问句带范围+颗粒度） | minute-<code> 等 | fuyao 高频端点被锁（code=2004）、K线只支持 1d；分时只能走问财 |
| **公告** | 问财渠道 `search --channel announcement`（iwencai 技能 announcement-search） | announcement | 沪深北公告全文检索 + 原文/PDF 链接；**fuyao 无此能力** |
| **新闻/资讯** | 问财渠道 `search --channel news`（iwencai 技能 news-search） | news | 官媒/财经媒体/行业站 + 券商研报摘要；题材催化剂的直接来源 |
| **全市场涨跌家数（广度）** | `daily-snapshot` 落 `breadth`（一次全市场快照 + 本地聚合） | breadth | 5575 只的涨/跌/平家数，复盘"普涨普跌"的硬口径；明细 1.2MB **不进上下文** |
| **问财选股** | 问财渠道 `search --channel astock` | — | 自然语言多条件筛选（行情+财务+技术形态+概念）；fuyao 没有筛选能力 |
| **事件/排雷** | 问财渠道 `search --channel event` | — | 业绩预告/增发/质押/解禁/调研/监管函——**排雷主力** |
| **股东股本** | 问财渠道 `search --channel holder` | — | 股东户数、前十大股东、实控人、质押（fuyao 无） |
| **机构观点/研报** | 问财渠道 `search --channel research|report` | — | 评级/目标价/业绩预测/券商金股 + 研报标题 |
| **宏观/行业/板块筛选/指数** | 问财渠道 `search --channel macro|industry|sector|index` | — | 宏观指标、行业估值排名、板块筛选（fuyao 板块只有目录+行情） |
| **基本资料/经营/ETF/可转债** | 问财渠道 `search --channel profile|business|etf|cb` | — | 上市日期/股本/费率、主营构成/客户/供应商、ETF 与可转债筛选 |
| 主力资金/高频动向 | **外部不可用**（官方仅对同花顺AI客户端开放，实测 `code=2004`） | — | 别再试调；如实告知"该数据源当前拿不到" |
| 期货/期权/QDII/基金经理 | **未接入** | — | 本项目只做 A股 + ETF/场外基金；用户问起如实说明 |

> 取数统一走插件 CLI（内部 node fetch；本机 PowerShell/curl 的 schannel TLS 不可用）。**问财 SkillHub CLI 是纯 Python，Windows 不需要 git-bash/WSL**（实测），装技能用 `node __PROJECT_ROOT__/scripts/install-iwencai-skills.mjs`。
> **非交易日陷阱**：涨停/跌停/炸板池省略 `date_ms` 时按"服务端当前自然日"取，周末与节假日返回空池 → 会得出"涨停 0 家"的错结论。插件已自动按**最近交易日**取并在结果里标注；手动取数时记得自己带 `date_ms`。
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
| （`daily-snapshot` 自动产生的第 9 项） | breadth | 全市场涨跌家数（脚本落盘，不占上下文） |
| `search --channel announcement` | announcement | 公告（问财） |
| `search --channel news` | news | 新闻/资讯（问财） |
| `search --channel report|astock|event|holder|research|macro|index|sector|industry|profile|business|etf|cb` | 与通道同名的 type（如 `event`） | 问财其余通道（表格形态） |
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

模板文件：`__PROJECT_ROOT__/templates/review-template.md`。**模板内容是用户自己的框架，不要自行增删章节或改写措辞**（2026-09 按其确认新增了「消息面与公告」「持仓股分析」「风险日历」三节并顺延编号）。

**十二节结构**：一、大盘环境 ｜ 二、消息面与公告 ｜ 三、主线与热点追踪 ｜ 四、涨停数据 ｜ 五、龙虎榜 ｜ 六、今日操作回顾 ｜ 七、持仓股分析 ｜ 八、交易心理复盘 ｜ 九、认知增量 ｜ 十、风险日历（未来 3–5 日）｜ 十一、明日计划 ｜ 十二、明日预测与次日回测。

生成复盘笔记时：**先用 `read` 读取模板**，按当天数据填充；输出到 **`<复盘目录>/YYYY-MM-DD.md`**（复盘目录见上：`check` 会打印，默认探测到 `学习/金融/复盘`）。

**AI 填"事实可得"的部分（只填数字与原文，不写判断）**：
- 一、大盘环境：指数/量能/涨跌家数（全市场口径）/涨停跌停炸板数/封板率 —— `daily-snapshot` 落盘后从缓存取；**每行都要带数据日期**；非交易日按"最近交易日"填并注明。
- 二、消息面与公告：公告/新闻/政策条目（标题 + 日期 + 出处链接），排雷五项逐项给"有/无"——`search --channel announcement|news`；通道未启用就写"未启用"，**不许用记忆替代**。
- 三、主线与热点追踪：**只填数据部分**（板块涨幅前 10、涨停梯队、封板率口径）。
- 四、涨停数据、五、龙虎榜：家数/封板率/席位数据。
- 七、持仓股分析：①今日交易流水（`position today`）②持仓状态（`position review`：成本/现价/浮动/触发状态/操作取向）+ 一行指向 `复盘/持仓分析/持仓分析-YYYY-MM-DD.html`。
- 十、风险日历：检索到的事件 + **来源链接**；检索不到写"未查到"。

**必须用户自己写的（AI 不臆造、不替写）**：三的**四维度评分与关键思考**；六、今日操作回顾的买卖逻辑与心理；七的"我的执行偏差"；八、交易心理复盘；九、认知增量；十一、明日计划与铁律；十二、预测与回测。
用户明确要求时才能给出带「AI 观点，非仓库已有」标注的草案。

数据不可用的字段如实标注"暂无"；**北向资金已停止实时披露，该行不填数字**。

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

**精度**：所有金额/价格/手续费/盈亏内部按"分"（整数）计算，显示为两位元——无 JS 浮点误差（如 0.1+0.2 不会是 0.3000004）。**行情价另按"厘"（0.001 元）存**：ETF/基金报价最小变动 0.001，用分记价会把 4.532 压成 4.53、乘股数后市值偏差；市值/浮盈 = 厘×股数 后再四舍五入到分。
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

## 问财渠道（`search`，17 个通道）

fuyao 负责**行情/财务/涨停龙虎榜/板块/ETF**；问财渠道补 fuyao 完全没有的**消息面 + 筛选/事件类**：公告、新闻、研报、**问财选股**、事件（业绩预告/质押/解禁）、股东股本、机构评级、宏观、行业、板块筛选、可转债筛选等。

```bash
node __PROJECT_ROOT__/src/cli.js search --channel announcement --q "贵州茅台 分红公告" --size 5       # 公告（带原文 PDF）
node __PROJECT_ROOT__/src/cli.js search --channel event       --q "宁德时代 解禁 质押" --size 5       # 排雷：事件
node __PROJECT_ROOT__/src/cli.js search --channel astock      --q "ROE大于15% 市盈率小于30 主力净流入" --size 10  # 问财选股
node __PROJECT_ROOT__/src/cli.js search --channel holder      --q "贵州茅台 股东户数 前十大股东" --size 3
node __PROJECT_ROOT__/src/cli.js search --channel research    --q "宁德时代 目标价 评级" --size 5
node __PROJECT_ROOT__/src/cli.js search --channel news        --q "固态电池 政策 最新" --size 5 --summary
node __PROJECT_ROOT__/src/cli.js search --channel report      --q "人形机器人 产业链 深度" --size 5
```

| 别名 | 用途 | 别名 | 用途 |
| :--- | :--- | :--- | :--- |
| `announcement` | 公告全文 + 原文PDF链接 | `macro` | 宏观（GDP/CPI/PPI/社融/M2/PMI） |
| `news` | 新闻/资讯（官媒·财经媒体·行业站） | `index` | 指数行情（上证/沪深300/创业板/恒生/纳指） |
| `report` | 券商研报（标题·评级·目标价） | `sector` | 板块筛选（估值/资金流/涨跌幅/板块类型） |
| `astock` | **问财选A股**（行情+财务+技术形态+概念多条件） | `industry` | 行业（估值/财务/盈利/排名） |
| `market` | 行情（价格/涨跌幅/成交量/资金流/技术指标） | `profile` | 基本资料（上市日期/股本/费率） |
| `finance` | 财务（营收/净利/ROE/负债率/现金流） | `business` | 经营（主营构成/客户/供应商/参控股） |
| `event` | 事件（业绩预告/增发/质押/解禁/调研/监管函） | `etf` | ETF 筛选 |
| `holder` | 股东股本（户数/十大股东/实控人/质押） | `cb` | 可转债筛选 |
| `research` | 机构观点（评级/业绩预测/ESG/券商金股） | — | — |

- **检索词就是"能问出来的问句"**：`标的/主题 + 指标或事件`（如「ROE大于15% 市盈率小于30」「贵州茅台 解禁」「ETF 规模排名」）。问财对**筛选条件**敏感、对"最大/最好"这类模糊词不敏感——「规模最大的沪深300ETF」返回 0 条，改成「沪深300ETF 有哪些」就有；问不出来就换个说法，别硬凑。
- **输出两种形态**：`announcement|news|report` 返回 `items[{date,title,source,url,summary}]`；其余（`astock|market|finance|event|holder|research|macro|index|sector|industry|profile|business|etf|cb`）返回**中文列表格** `columns[] + items[]（行对象）`。默认纯 JSON；`--summary` 人读摘要；`--raw` 网关原始 JSON；`--save <type>` 落缓存。
- **直接传技能 slug 也行**：`--channel hithink-astock-selector`（以后新装技能无需改代码）。

### 分时（日内分钟线）—— 只能走问财

fuyao 的**高频端点对外被锁**（`high-frequency/intraday|historical` 实测 `code=2004`，仅同花顺AI客户端），`price-historical` **只支持 1d**（传 `5m` 报 `code=1002`）。所以日内分时用问财 `--channel market --series`：

```bash
# 单日 1 分钟（收盘价 + 成交量）
node __PROJECT_ROOT__/src/cli.js search --channel market --q "贵州茅台 今日9:30到15:00每分钟收盘价和成交量" --series --summary
# 单日 5 分钟
node __PROJECT_ROOT__/src/cli.js search --channel market --q "中天科技 今日9:30到15:00每5分钟收盘价" --series --summary
# 多日：每日分时（含 09:15/09:25 集合竞价点）
node __PROJECT_ROOT__/src/cli.js search --channel market --q "贵州茅台 近5个交易日 每日分时成交额" --series --save minute-600519
```

- **问句模板**：单日 `<标的> 今日9:30到15:00每<1|5|15|30|60>分钟<字段>`；多日 `<标的> 近N个交易日 每日分时<字段>`。
  **不写时间范围/颗粒度就不会展开成序列**（实测只回 1 个最新值）；多日别写 `9:30到15:00每分钟`（实测不展开），用「每日分时」。
- **为什么必须 `--series`**：问财的分时是"**每列一个时间点**"的宽表（1 分钟一天 ≈ 480 列、倒序），不加 `--series` 会把几百列灌进上下文；加了才转成按时间升序的 `series[{date,time,<字段>}]`。
- **容量**：单次最多 2000 个时间点（超出保留末尾并置 `truncated`）；`--save <type>` 落盘后用 `cache latest --type <type>` 读。
- **口径**：分时为**未复权**原始价，且含集合竞价点（09:15/09:25）；跨除权日的多日区间要自己对齐复权，或只用单日。
- **Key 与安装**：Key 存在 `.a-share-assistant/config.json` 的 `iwencai.apiKey`（git 忽略，**不要写进笔记/仓库**）；技能装在 `~/.agents/skills/`。
  - 技能缺失、或用户想加问财的其他技能（选股 `hithink-astock-selector` / 事件 `hithink-event-query` / 股东 `hithink-management-query` / 机构评级 `hithink-insresearch-query`）：**一条命令搞定**——`node __PROJECT_ROOT__/scripts/install-iwencai-skills.mjs [--skills <技能名>]`（内部自动找 Python、下官方 SkillHub CLI、装、校验；`--check` 只看状态）。
  - 用户没配 Key 时：如实说明"公告/新闻通道没开"，并给出去 https://www.iwencai.com/skillhub 获取的方式；**不要用记忆或 web 搜索冒充公告原文**。
- **合规口径**：引用时注明 `数据来源：同花顺问财`，并给原文链接与日期；检索不到就如实说没找到，**不要用记忆替代**。

## 持仓分析 / 复盘页（position review）

把**台账持仓**与**当日真实行情**逐只对照，判定"触发了没、该加仓/持有/止盈/止损"；HTML 报告是**完整复盘页**（大盘 + 板块 + 今日流水 + 持仓逐只 + 风险日历）。判定引擎照《复盘模板生成指南》§3，**只标注「计划 vs 现实」的偏差，不换股、不改计划参数**。

```bash
node __PROJECT_ROOT__/src/cli.js position plan --code 600129 --stop 13.30 --target 15.00 --zone 13.00-13.60   # 给持仓补/改计划参数（传 0 清除）
node __PROJECT_ROOT__/src/cli.js position add --code 600519 --shares 100 --price 1500 --stop 1450 --target 1650  # 建仓时一并记
node __PROJECT_ROOT__/src/cli.js position review [--date D] [--account X]     # 完整复盘页（默认：终端表格 + Markdown 片段 + HTML 报告）
node __PROJECT_ROOT__/src/cli.js position review --no-market                  # 跳过大盘/板块（省请求，只要持仓）
node __PROJECT_ROOT__/src/cli.js position review --no-html --no-md            # 只要终端表格（省 token）
node __PROJECT_ROOT__/src/cli.js position review --events events.json         # 带风险日历（见下）
node __PROJECT_ROOT__/src/cli.js position review --out <路径> --md-file <路径>  # 指定输出位置
```

**输出位置（约定，别散放）**：HTML 报告默认写 **`<复盘目录>/持仓分析/持仓分析[-账户]-YYYY-MM-DD.html`**——与当日复盘笔记 `<复盘目录>/YYYY-MM-DD.md` 同处一层下的按类型子目录，复盘根目录只留笔记和固定文件夹。引用报告时用相对路径 `持仓分析/持仓分析-YYYY-MM-DD.html`。

**判定优先级**（逐只，用当日 开/高/低/收 与计划参数比）：
1. 盘中最低 ≤ 止损 → `⚠️ 盘中破止损`（按纪律离场，不摊平）
2. 收盘距止损 < 2% → `⚠️ 逼近止损`
3. 盘中最高 ≥ 目标 → `🎯 触第一目标`（分批止盈，不追高）
4. 收盘距目标 < 2% → `🎯 逼近目标`（可减半仓）
5. 最低 ≤ 买入区上沿 且 收盘 ≥ 止损 → `✅ 回到买入区`（计划内低吸/加仓，不追阳线）
6. 其余 → `➖ 持有观察`

**HTML 报告（复盘页）结构**：
| 区块 | 数据来源 |
| :--- | :--- |
| 一、今日大盘 | 指数快照（沪/深/创）+ 涨跌停情绪（涨停/跌停/炸板/封板率/最高连板/概念涨跌家数） |
| 二、板块表现 | THS 概念目录（390 个）+ **一次批量**指数快照 → 领涨/领跌 Top8 表 + 图 |
| 三、今日交易流水 | 台账当日流水（时间/方向/股数/成交价/手续费/已实现/备注） |
| 四、持仓逐只分析 | 持仓快照 + 当日日线 vs 计划参数；卡片含**建仓日/已持有天数/最近一笔** |
| 五、风险日历 | `--events` 传入（本插件**不编造**事件；见下） |

**要点**：
- **持仓 ≠ 今日交易**：报告卡片必须保留「建仓 / 最近一笔」字段——存量持仓被误读成"今天买的"是最容易踩的坑；当日买卖另看「今日交易流水」。
- **没记止损/目标/买入区的持仓只做成本盈亏分析**（不猜参数）；提示用户用 `position plan` 补齐后即可参与触发判定。
- **风险日历**：命令行 `--events <文件|JSON>` 传 `[{date,title,impact,source}]`。复盘时 AI 用 **web 搜索**补齐（宏观数据发布、解禁、会议、财报窗口等）并**在 source 列标注链接**；搜不到就留空，**绝不编**。
- **精度**：行情价按"厘"（0.001 元）整数存储，ETF/基金三位小数不丢；市值/浮盈 = 厘×股数 后再舍入到分。
- **口径**：股票用**未复权**价判止损/目标（前复权会和当初的计划价错位）；ETF 走 fund 接口（只有前复权）。快照取不到自动退回最近一根日线并标明数据源；仍取不到则按成本价并**显式告警**（浮盈是假象）。指数/涨跌停数据自带日期，报告顶部标注，与复盘日不一致时不冒充当日。
- **复盘接入**：把 Markdown 片段贴到「今日操作回顾」或「明日计划」附近；AI **不替用户做买卖决定**，只给触发事实 + 纪律取向。

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
2. 按模板生成 `<复盘目录>/YYYY-MM-DD.md`（复盘目录由 CLI 解析，见开头说明；`check` 会打印）
3. 提示时间戳与注意事项

