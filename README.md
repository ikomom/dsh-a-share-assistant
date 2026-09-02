# dsh-a-share-assistant

DSH 插件：A股助手。新建会话时选择「A股助手」预设，即可在对话中完成 A 股研究（选股 / 排雷 / 盯盘 / 复盘），数据走本地缓存层。

## 形态

- **预设包**：`presets/a-share-assistant/`（preset.yml + agent.cordis.yml + skills）→ 安装进 `~/.dsh/.agent-presets/`
- **缓存 CLI**：`src/cli.js`（node 实现，写入 `.stock-analysis`）——仅供本插件内部与手动运维使用
- **数据源**：同花顺金融数据 API（fuyao.aicubes.cn，`node fetch` 直连）

## 目录约定

```
. 工作区根
├── .stock-analysis/   # 缓存层（git 忽略，插件读写）
└── 学习/金融/复盘/     # AI 生成的复盘笔记（进 git）
```

## 使用

```bash
# 环境自检（网络连通性 + 缓存目录）
node src/cli.js check

# 缓存管理
node src/cli.js cache status
node src/cli.js cache snapshot --type limit-up --file limit-up.json
node src/cli.js cache latest --type limit-up
node src/cli.js cache get --type limit-up --date 2026-08-19
node src/cli.js cache clean

# 安装预设到 DSH
node scripts/install-preset.js
```

## 设计约束（实测结论）

- 本机 PowerShell/curl 的 SSL（schannel）无法连通 fuyao / GitHub，**只有 Node fetch 可用**——所有取数必须走 Node
- API Key 等敏感值一律不写进代码/预设，放环境变量（`FUYAO_API_KEY`）或 会话目录 `./.a-share-assistant/config.json` 的 `fuyao.apiKey` 字段（系统产物目录，git 忽略）（需在 https://fuyao.aicubes.cn 官网签发）
- 缓存目录由 `./.a-share-assistant/config.json` 的 `cacheRoot` 指定（默认 `./.a-share-assistant/cache`），可用环境变量 `A_SHARE_CACHE_DIR` 覆盖
- **工作目录约束**：A股助手预设的会话应选择 vault 目录（`./.a-share-assistant/config.json` 的 `vaultRoot`）作为工作目录；复盘笔记写入 `{{cwd}}/复盘/`，不依赖会话 cwd
- **先体检禁考古**：会话中任何数据任务第一步运行 `node src/cli.js check`；若数据链路未就绪（key 缺失/端点为空），立即告知用户修复指引，禁止现场翻文档/源码猜接口

## 跨平台支持

| 平台 | 状态 | 说明 |
| :--- | :--- | :--- |
| Windows | ✅ 已验证 | 本机完整跑通；schannel TLS 仅 Windows 有，取数走 CLI（内部 node fetch）绕过 |
| Linux | 🟡 代码兼容，未实测 | node + 跨平台 path + HTTP 数据源，无盘符硬编码；建议先跑 `node src/cli.js check` 自检；问财 SkillHub CLI（`.sh`）反而原生 |
| macOS | 🟡 代码兼容，未实测 | 同 Linux，跑 `check` 自检 |

**通用安装**（任何平台一致）：
1. `node >= 18`（install 前置检查）
2. `node scripts/install-preset.js`（复制预设到 `~/.dsh/.agent-presets/`，按平台注入 persona 提示）
3. `node src/cli.js config --init` → 编辑 `./.a-share-assistant/config.json` 填 `vaultRoot / cacheRoot / fuyao.apiKey`（**自备 key**，官网签发）
4. 新建会话选「A股助手」，先跑 `check` 自检

**给使用者的关键提醒**：本插件**需要你自己的 fuyao API Key**（数据源是付费/需登录签发的服务），不属于"clone 即免 key 使用"；但代码/路径/配置完全跟机器走，换平台、换机器只需重新配置，无需改代码。

