# A股助手 · AI 一句话安装

把下面的指令块**整段复制给任意一个 DSH 会话**的 AI（或直接对它说"按 AI_INSTALL 帮我安装A股助手"），AI 会自动完成安装。涉及需要决策的（安装位置、笔记目录、key、要不要开公告/新闻通道）AI 会用 `ask_user` 问你；**不会**擅自决定、猜路径、或把 key 打到对话里。

> **两个 Key 的区别**：`fuyao.apiKey`（必填）＝ 行情/财务/涨停龙虎榜/复盘/持仓分析主链路；`iwencai.apiKey`（可选）＝ 公告/新闻通道。**只配 fuyao 也能完整用**，公告/新闻是加分项。

```text
请帮我安装 A股助手 插件到本机 DeepSeek Harness，按以下步骤执行。凡是要你决策的（安装位置、笔记目录、API Key），先用 ask_user 问我，不要擅自决定或编造；不要把 fuyao API Key 打印到对话或写进任何仓库文件。

1. 前置：运行 `node -v` 确认 Node >= 18（不够则提示我升级并停止）。
2. 克隆：若当前目录没有 `dsh-a-share-assistant`，运行
   `git clone https://github.com/ikomom/dsh-a-share-assistant.git`
   （克隆到当前工作目录；若我指定了别的目录则用指定的）。
3. 安装预设：运行
   `node dsh-a-share-assistant/scripts/install-preset.js`
   （复制预设到 ~/.dsh/.agent-presets/ 并按本机平台适配 persona）。
4. 生成配置：运行
   `node dsh-a-share-assistant/src/cli.js config --init`
   然后打开 `.a-share-assistant/config.json`（即 dsh-a-share-assistant 所在目录下的 .a-share-assistant/config.json）：
   - 用 ask_user 问我的 «我的笔记库目录路径» ，填到 `noteRoot`；
   - `cacheRoot` 留空即可（默认 .a-share-assistant/cache）；
   - `fuyao.apiKey`：**提醒我自己去 https://fuyao.aicubes.cn 官网签发并粘贴**，不要替我从别处拿、不要打印。
5. 自检：运行 `node dsh-a-share-assistant/src/cli.js check`，告诉我是否"数据链路就绪"；若没有，把缺什么（key/目录/网络）讲清楚。
6. 可选增强（问财「公告/新闻」通道，**默认不装**）：先问我"要不要开公告/新闻通道？"。我说不要 → 跳过，并告诉我"行情/财务/涨停龙虎榜/复盘主链路不受影响"；我说要 → 按 a→b→c 顺序做完，**任何一步失败都要如实说明并停在原地，不要假装成功**：
   a. 装技能（一条命令；内部自动：找 Python → 下载同花顺官方 SkillHub CLI → 解压 → 装 announcement-search + news-search → 校验）：
      `node dsh-a-share-assistant/scripts/install-iwencai-skills.mjs`
      - 想看状态不安装：加 `--check`；想强制重下 CLI：加 `--force`；只装一个：`--skills announcement-search`
      - 若报「未找到 Python 3」→ 把命令里给的安装提示原样转述给我，本轮先不开通道（其余功能照常用）。
   b. 配 Key：用 ask_user 问我的 IWENCAI_API_KEY，或提醒我去 https://www.iwencai.com/skillhub 登录后复制。
      拿到后写进 `.a-share-assistant/config.json` 的 `iwencai.apiKey`。**绝不把 Key 打印到对话、不回显、不写进任何仓库文件**；我自己说"先不配"就跳过并说明通道暂不可用。
   c. 验收（必须真跑一次，返回真实公告才算成功；把其中一条的标题+日期+来源念给我确认）：
      `node dsh-a-share-assistant/src/cli.js search --channel announcement --q "贵州茅台 分红公告" --size 2 --summary`
7. 收尾：提示我在 DSH 界面【新建会话 → 预设选择「A股助手」】，即可对话使用；并提醒"当前已开的会话不会热切换预设，需要新建会话"。若开了公告/新闻通道，再提醒一句"以后要加问财的选股/事件/股东/研报技能，还是这条命令：`node scripts/install-iwencai-skills.mjs --skills <技能名>`"。


