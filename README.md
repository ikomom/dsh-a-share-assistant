# dsh-a-share-assistant

[![Release v0.1.3](https://img.shields.io/badge/release-v0.1.3-5B4CF0?style=flat-square)](https://github.com/ikomom/dsh-a-share-assistant)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-0B7285?style=flat-square)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh%20plugin-5B4CF0?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**DeepSeek Harness A股研究助手插件**：新建会话选择「A股助手」预设，即可在对话中完成选股、排雷、盯盘、复盘。数据走同花顺金融数据 API（fuyao.aicubes.cn），带本地缓存层。

## 功能

| 能力 | 说明 |
|---|---|
| 场景路由 | 选股 / 个股体检、盯盘、复盘、策略验证 5 大场景，AI 按路由调数据 |
| 数据能力 | 41 个可用端点：行情快照、历史K线+复权因子、财务三表、财务指标、涨跌停/炸板池、连板天梯、龙虎榜（机构/游资）、热股榜（含历史/个股走势）、异动原因（个股+列表）、集合竞价、估值、板块/概念、指数、交易日历、标的列表、ETF/基金 12 项 |
| ETF / 基金 | ETF 前复权日线 + 行情快照；基金资料、区间收益、净值、最大回撤、历史业绩指标、重仓持仓、资产配置、诊断、前十大持有人、分红记录——场内 ETF 与场外公募基金都能查 |
| 全市场导出 | `market-dump-url` 取 10 年全市场日K / 最近 10 交易日日K / 复权因子 Parquet 预签名下载链接（5 分钟有效），适合离线回测与自建库 |
| 消息面检索 | 问财渠道 `search`：**公告**（沪深北全文 + 交易所原文 PDF 链接）、**新闻/资讯**（官媒/财经媒体/行业站 + 券商研报摘要）——fuyao 没有的消息面，排雷与找催化剂用 |
| 个股与 ETF 体检 | `investigate` 自动判别标的类型：股票走财务三表+指标+估值+异动，ETF 走资料+收益+回撤+持仓+诊断；一票否决式排雷，结论带数据时间戳 |
| 复盘报告 | 涨停梯队 / 龙虎榜游资 / 板块热度 → 自动生成 `复盘/YYYY-MM-DD.md` 进笔记库 |
| 交易台账 | 记录本金、建仓/加仓/卖出、每笔心理备注（**股票 / ETF / 国债逆回购**）→ `position`，AI 对话记账，复盘"操作回顾"自动引用 |
| 持仓分析/复盘页 | 台账持仓的「成本 / 止损 / 目标 / 买入区」vs 当日真实行情（开高低收）→ 逐只判定**可低吸 / 止盈 / 止损预警 / 持有观察** + 操作取向；HTML 报告含**今日大盘（指数+涨跌停情绪）、板块领涨领跌、今日交易流水、持仓逐只（建仓日/最近一笔）、风险日历**；涨红跌绿、ECharts 内联，断网可开 |

> 官方另有「主力资金」「高频动向」等能力，目前仅对同花顺 AI 客户端开放（外部 Key 调用返回 `code=2004`），本插件不做无谓重试。

## 数据源与缓存

- **数据源**：同花顺金融数据 API（fuyao.aicubes.cn），HTTP 直连。
- **缓存**：系统产物（配置 + 缓存 + 台账）放会话工作目录 `.a-share-assistant/`（点开头默认隐藏、git 忽略）；用户产物（复盘笔记）放会话目录可见位置。缓存层：JSON 索引 + 三档保留（近30天散装 → 月zip归档 → 超期删除）、按标的过滤、TTL 过期判定。
- **API Key**：fuyao Key 在 https://fuyao.aicubes.cn 自签，填入 `.a-share-assistant/config.json` 的 `fuyao.apiKey`；**问财 Key**（公告/新闻通道）在 https://www.iwencai.com/skillhub 获取，填入同一文件的 `iwencai.apiKey`（**都不写进代码/仓库**）。
- **问财技能**：`search` 依赖 iwencai SkillHub 的 `announcement-search` / `news-search` 技能，装在 `~/.agents/skills/`；缺技能时 CLI 报错会给安装命令。
- **交易台账**：`.a-share-assistant/portfolio.json`（本金/每笔操作/盈亏，个人财务**敏感，留本机 git 忽略**）；复盘笔记写 `复盘/`（知识产物，进笔记库随版本管理）。

## 安装

### 方式一：命令安装

前置：Node.js ≥ 18、DeepSeek Harness 环境、你自己的 fuyao API Key（在 https://fuyao.aicubes.cn 官网签发）。

```bash
git clone https://github.com/ikomom/dsh-a-share-assistant.git && cd dsh-a-share-assistant && node scripts/install-preset.js
```

一条命令完成：预设安装 + 平台适配 + 配置引导（配置缺失时在终端交互询问是否生成；无交互环境则提示手动 `config --init`）。

之后编辑 `./.a-share-assistant/config.json` 填写：

```jsonc
{
  "noteRoot": "你的笔记库目录，如 D:/docs/private-doc 或 ~/notes",
  "reviewDir": "复盘目录（相对 noteRoot 或绝对路径），复盘笔记与持仓分析报告都写这里；留空则自动探测：{noteRoot}/学习/金融/复盘 → {cwd}/学习/金融/复盘 → {noteRoot}/复盘",
  "cacheRoot": "缓存目录，默认 .a-share-assistant/cache，可留空",
  "fuyao": { "apiKey": "你的 fuyao API Key（必填，行情/财务/复盘主链路）" },
  "iwencai": { "apiKey": "可选：问财 Key（公告/新闻通道，见下）" }
}
```

> **复盘产物落盘约定**：复盘笔记写 `<复盘目录>/YYYY-MM-DD.md`，持仓分析报告写 **`<复盘目录>/持仓分析/持仓分析-YYYY-MM-DD.html`**（同层按类型归档，不平铺）。
> `node src/cli.js check` 会打印当前解析出的「复盘目录」，`A_SHARE_REVIEW_DIR` 环境变量优先级最高。

### 可选增强：公告 / 新闻通道（问财）

fuyao 没有公告与新闻，这两块走同花顺问财渠道。**不装也完全不影响**行情/财务/涨停龙虎榜/复盘/持仓分析，装了才多出 `search` 命令：

```bash
node scripts/install-iwencai-skills.mjs           # 一条命令：查 Python → 下官方 SkillHub CLI → 装两个技能 → 校验
node scripts/install-iwencai-skills.mjs --check   # 只看状态，不下载不安装
node src/cli.js search --channel announcement --q "贵州茅台 分红公告" --size 5 --summary
```

需要：本机 Python 3（脚本会检测并给出安装提示）+ 问财 Key（填进 `config.json` 的 `iwencai.apiKey`，在 https://www.iwencai.com/skillhub 获取）。
脚本只从同花顺官方 CDN 取 CLI，技能由该 CLI 从 `ms.10jqka.com.cn` 拉取，**不碰任何 Key**；Key 由你或 AI 写进 git 忽略的本地配置。

### 方式二：一句话请 AI 装

把 [`AI_INSTALL.md`](./AI_INSTALL.md) 里的指令块整段发给任意 DSH 会话的 AI，AI 会自动完成克隆 → 装预设 → 引导配置 → 自检 → **（可选）问你要不要开公告/新闻通道并替你装好** → 收尾；需你决策的用 `ask_user` 询问，key 不经过对话。

### 安装后

DSH 界面**新建会话 → 预设选择「A股助手」**，先跑 `node src/cli.js check` 自检。

会话内支持 **`/compact`**（上下文压缩）：上下文吃紧时自动压缩，也可手动敲 `/compact` 立即压缩一段较老历史（不消耗模型轮次）。长会话做复盘前敲一次，能明显压低后续 token 成本。

## 使用

对话中直接说：

- 「帮我看看华电辽能的情况」→ 个股体检报告
- 「今天有什么题材值得看？」→ 盘前找方向（板块/涨停/新闻）
- 「收盘复盘」→ 自动生成复盘笔记（`daily-snapshot` 一次落盘涨停/龙虎榜/板块等）
- 「记一笔：建仓茅台 100 股 1500」→ 交易台账（记录本金/操作）
- 「今天交易了啥」→ 当日交易流水（含心理备注）
- 「这个策略历史表现如何」→ 历史行情/财务做策略验证

### CLI 子命令

```bash
node src/cli.js check                # 数据链路体检（网络/Key/端点/缓存 + 参数速查）
node src/cli.js check --quick        # 轻量体检：只判断链路就绪（日常用，会话内复用）
node src/cli.js config --init        # 生成配置
node src/cli.js config --template    # 生成模板自行创建
node src/cli.js config --status      # 查看配置状态
node src/cli.js cache status         # 缓存状态
node src/cli.js cache latest --type <type> [--code X]   # 取最近缓存（--code 查个股）
node src/cli.js data --kind <端点> [参数] [--save <类型> [--code X]]
                                     # 取数并可选落缓存（--kind X --help 看参数）
node src/cli.js investigate --code X [--report YYYY-N]   # 一键体检（股票/ETF 自动判别，拉齐数据落盘）
node src/cli.js data --kind fund-returns --thscode 510300.SH    # ETF/基金：区间收益
node src/cli.js data --kind fund-market-historical --thscode 510300.SH --interval 1d --start 2026-08-01 --end 2026-09-17
node src/cli.js data --kind market-dump-url --dump daily-k-10d  # 全市场日K Parquet 下载链接
node src/cli.js search --channel announcement --q "贵州茅台 分红公告"   # 公告检索（问财渠道）
node src/cli.js search --channel news --q "人工智能 政策" --summary     # 新闻/研报资讯
node src/cli.js position init --capital N                       # 设初始本金
node src/cli.js position add --code X --shares N --price P [--psych "心理备注" --fee N | --auto-fee [--account 名称]]  # 建仓/加仓（加权成本）
node src/cli.js position sell --code X --shares N --price P [--psych "心理备注" --fee N | --auto-fee]  # 减仓/清仓（自动算已实现盈亏）
node src/cli.js position psych --code X --text "复盘：这笔追高"  # 给某笔补心理备注
node src/cli.js position list | summary | today                 # 持仓/总览/当日流水
node src/cli.js position plan --code 600129 --stop 13.30 --target 15.00 --zone 13.00-13.60  # 记录计划参数
node src/cli.js position review                                 # 持仓分析/复盘页（大盘+板块+今日流水+持仓；含 HTML 报告）
node src/cli.js position review --no-market --no-html --no-md   # 只要终端表格
node src/cli.js position review --events events.json            # 附风险日历（[{date,title,impact,source}]，AI 复盘时 web 搜索补）
node src/cli.js daily-snapshot [--date D]                       # 一键每日复盘快照（涨停/龙虎榜/板块/指数等落盘）
```

端点参数示例：`data --kind price-historical --thscode 600396.SH --interval 1d --start 2026-08-01 --end 2026-08-17`。
详细参数用 `data --kind <端点> --help` 查询（含必填项、枚举取值、注意事项），`check` 末尾有速查表。
日期参数可写 `YYYY-MM-DD`（自动转 Asia/Shanghai 毫秒戳，接口只认毫秒戳）。

## 安全与合规

- API Key 只存 `.a-share-assistant/config.json`（git 忽略），代码/仓库零敏感值
- 数据仅限自用，不二次分发
- 工具输出的所有结论可溯源（数据源原值 + 时间戳），不编造数字

## License

MIT

内置第三方资源：`assets/echarts.min.js`（Apache ECharts 5.5.1，Apache-2.0），仅用于让持仓分析 HTML 报告**离线自包含地出图**；详见 [`assets/README.md`](./assets/README.md)。


