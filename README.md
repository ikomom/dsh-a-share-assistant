# dsh-a-share-assistant

[![Release v0.1.2](https://img.shields.io/badge/release-v0.1.2-5B4CF0?style=flat-square)](https://github.com/ikomom/dsh-a-share-assistant)
[![Node >=18](https://img.shields.io/badge/Node-%3E%3D18-0B7285?style=flat-square)](https://nodejs.org/)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-dsh%20plugin-5B4CF0?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)

**DeepSeek Harness A股研究助手插件**：新建会话选择「A股助手」预设，即可在对话中完成选股、排雷、盯盘、复盘。数据走同花顺金融数据 API（fuyao.aicubes.cn），带本地缓存层。

## 功能

| 能力 | 说明 |
|---|---|
| 场景路由 | 选股 / 个股体检、盯盘、复盘、策略验证 5 大场景，AI 按路由调数据 |
| 数据能力 | 28 个真实端点：行情快照、历史K线+复权因子、财务三表、财务指标、涨跌停/炸板池、连板天梯、龙虎榜（机构/游资）、热股榜（含历史/个股走势）、异动原因（个股+列表）、集合竞价、估值、板块/概念、指数、交易日历、标的列表 |
| 本地缓存 | `.a-share-assistant/` 目录，JSON 索引 + 三档保留（近30天散装→月zip归档→超期删除）、按标的过滤、TTL 过期判定 |
| 个股体检 | 财务三表 + 指标 + 估值 + 异动 + 新闻兜底，一票否决式排雷，结论带数据时间戳 |
| 复盘报告 | 涨停梯队 / 龙虎榜游资 / 板块热度 → 自动生成 `复盘/YYYY-MM-DD.md` 进笔记库 |
| 先体检禁考古 | 数据任务第一步跑 `check`，链路未就绪立即停下给指引，绝不现场翻源码 |
| 技能纯净 | 宿主注入的无关全局技能被隔离，AI 只认本插件技能 |
| 错误自愈 | 端点参数元数据 + 必填预检 + 缺参示例命令，参数试错次数大幅下降 |

## 数据源与缓存

- **数据源**：同花顺金融数据 API（fuyao.aicubes.cn），HTTP 直连。
- **缓存**：系统产物（配置 + 缓存）放会话工作目录 `.a-share-assistant/`（点开头默认隐藏、git 忽略）；用户产物（复盘笔记）放会话目录可见位置。
- **API Key**：需在 https://fuyao.aicubes.cn 官网自签，填入 `.a-share-assistant/config.json` 的 `fuyao.apiKey`（**不写进代码/仓库**）。

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
  "cacheRoot": "缓存目录，默认 .a-share-assistant/cache，可留空",
  "fuyao": { "apiKey": "你的 fuyao API Key（必填）" }
}
```

### 方式二：一句话请 AI 装

把 [`AI_INSTALL.md`](./AI_INSTALL.md) 里的指令块整段发给任意 DSH 会话的 AI，AI 会自动完成克隆 → 装预设 → 引导配置 → 自检 → 收尾；需你决策的用 `ask_user` 询问，key 不经过对话。

### 安装后

DSH 界面**新建会话 → 预设选择「A股助手」**，先跑 `node src/cli.js check` 自检。

## 使用

对话中直接说：

- 「帮我看看华电辽能的情况」→ 个股体检报告
- 「今天有什么题材值得看？」→ 盘前找方向（板块/涨停/新闻）
- 「收盘复盘」→ 自动生成复盘笔记
- 「这个策略历史表现如何」→ 历史行情/财务做策略验证

### CLI 子命令

```bash
node src/cli.js check                # 数据链路体检（网络/Key/端点/缓存 + 参数速查）
node src/cli.js config --init        # 生成配置
node src/cli.js config --template    # 生成模板自行创建
node src/cli.js config --status      # 查看配置状态
node src/cli.js cache status         # 缓存状态
node src/cli.js cache latest --type <type> [--code X]   # 取最近缓存（--code 查个股）
node src/cli.js data --kind <端点> [参数] [--save <类型> [--code X]]
                                     # 取数并可选落缓存（--kind X --help 看参数）
```

端点参数示例：`data --kind price-historical --thscode 600396.SH --interval 1d --start 2026-08-01 --end 2026-08-17`。
详细参数用 `data --kind <端点> --help` 查询，`check` 末尾有速查表。

## 安全与合规

- API Key 只存 `.a-share-assistant/config.json`（git 忽略），代码/仓库零敏感值
- 数据仅限自用，不二次分发
- 工具输出的所有结论可溯源（数据源原值 + 时间戳），不编造数字

## License

MIT


