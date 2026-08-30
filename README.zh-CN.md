# Novus

> **手机是 agent，服务器是它的手。**

一个自我进化的 AI agent 框架，跑在任何有 Node.js 的地方——包括你口袋里的安卓手机。我已经不用背笔记本电脑了：agent 住在手机（Termux）上，通过一条 WebSocket 指挥我的云服务器、海外 VPS，甚至桌底的 Mac。

---

## 一个 AI agent 的本质是什么？

Claude Code 让世界知道了 agent 循环的样子。Novus 问的是另一个问题：**这个核心可以有多小？**

- **约 1.5 万行 TypeScript**（源码不到 1 MB）
- **16 个内置工具**，零配置动态注册
- **109 个测试**，几秒完成构建
- 手机、树莓派、VPS、笔记本都能跑——Node 能跑，Novus 就能跑

不捆绑重型 SDK，不锁定厂商。只有那个循环：*感知 → 思考 → 行动 → 记忆 → 进化*。

## 它真的在自我进化

不是营销话术里的「自我改进」。这个闭环是具体的——就在写这份 README 的那天，它完整跑了一遍：

- **读写自己的源码** —— 那天它在自己的联邦注册表里发现了 4 个 bug（写死的版本号、一个无法识别的节点类型、一个杀不死的僵尸条目、一个谎报存活状态的探测），自己改 TypeScript、自己编译、自己把补丁推到每一台它运行的机器上
- **给自己的舰队部署更新** —— 手机 → 云 VM → 海外 VPS，走 SSH 和 WebSocket
- **跨会话保存教训** —— 持久知识库，不是重启就清空的上下文窗口。解法找到一次，教训就存一条；同样的坑不会踩第二次
- **盯着自己的习惯** —— 识别出 10 种行为模式（过度调用工具、重复搜索……），7 种已被自己定下的规则纠正，规则现在会拦截自己的工具调用
- **记录每一次进化** —— 已 15 次，每次都记着改了什么、为什么改

Bug → 自我诊断 → 自我修补 → 自我部署 → 教训入库。全程没有人类敲一行修复代码。维护者全程围观，然后更新了这份 README。

*（联邦层本身在 v1.2 开源——见[路线图](#roadmap)。）*

## 五分钟上手

```bash
git clone https://github.com/YOUR_USER/novus.git && cd novus
npm install && npm run build
```

> **安卓用户**：先从 [F-Droid](https://f-droid.org/en/packages/com.termux/) 安装 Termux——Play 商店版已停止维护，无法使用。然后 `pkg install nodejs-lts git python make clang`（原生模块需要一套编译工具链），下面所有命令原样可用。完整步骤见 [MOBILE.zh-CN.md](MOBILE.zh-CN.md)。

> **Windows 用户**：需先安装 [Git for Windows](https://git-scm.com/download/win)——Novus 依赖它提供的 `git` 与 `bash` 命令。装好后在 Git Bash、WSL 或 cmd/PowerShell 中均可运行。

配置 LLM 端点——**任何 Anthropic 协议兼容的 API 都行**：

```bash
# 原生命名（推荐）
export NOVUS_BASE_URL="https://api.anthropic.com"
export NOVUS_AUTH_TOKEN="sk-ant-..."
export NOVUS_MODEL="claude-sonnet-4-20250514"

# 或者直接用你已有的 Claude Code 环境变量——自动识别
# ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
```

开箱即用：**Anthropic、DeepSeek、智谱 GLM、月之暗面 Kimi**、OpenRouter、LiteLLM 网关、本地推理服务。

### 关于图片

- **看图**：用 `read` 读任意 jpg/png/gif/webp/bmp 文件，会作为图像块发给模型——前提是 `NOVUS_MODEL` 是多模态模型（如 Claude Sonnet）。纯文本模型会静默忽略图片。
- **处理图片**（缩放、转格式、加水印）：任何模型都可——agent 自己写脚本完成。
- **生成图片**：未内置；写一个 custom tool（在 `src/tools/custom/` 放一个调用任意图像 API 的 `.ts`）即可接入。

```bash
npm link                  # 一次性注册全局 novus 命令
novus                     # 交互式对话
novus -p "修复这个仓库里失败的测试"
novus --serve --port 24999   # HTTP API + Web UI
```

> 已经在用 Claude Code？什么都不用配——Novus 自动读取你的 `ANTHROPIC_*` 环境变量。

## 内核能力

| 能力 | 说明 |
|---|---|
| 🧠 **三层记忆** | 知识库（语义）+ 情景经验（踩坑实录）+ 项目记忆（状态），全部跨会话持久化 |
| 🧬 **自我进化** | 进化追踪器 + 行为守卫：观察自己的工具调用模式，把纠正规则注入后续提示词 |
| 🔌 **动态工具** | 在 `src/tools/custom/` 丢一个 `.ts` 文件即自动注册，零配置零样板 |
| 🌐 **世界感知** | 网页抓取（raw/article/feed，可选无头浏览器模式）、GitHub 集成、代码库地图 |
| 📋 **规划执行** | 带依赖追踪的计划、执行记录、自动执行脚本生成 |
| 🤖 **自主任务** | 定时/事件触发的 agent 自主任务（on-start、periodic、event） |
| 📱 **Termux 原生** | Android 存储镜像、唤醒锁——为真正「住在手机上」而设计 |
| 🔓 **MCP 服务** | 把 Novus 记忆暴露为 MCP 工具，供其他 agent 调用 |

## 不是玩具——它在维护我的基础设施

Novus 是我**一个月高强度日用**的工具：140+ 个会话、560 条知识积累。它维护着一套三节点部署（手机 ↔ 云 VM ↔ 海外 VPS），自愈故障、每天产出科技新闻简报、自动发布文章。这个 agent 参与编写了自己的发布工具链——本 README 的叙事就是 Novus 自己起草的。

*多节点联邦层暂未开源——见 [路线图](#路线图)。*

## 不是设计出来的，是长出来的

Novus 不是从一张架构图开始的。它从一颗种子——一个最小的 agent 循环——长起来，你现在看到的每个能力，都是前一天踩到真问题后才长出来的：

- **记忆**，是因为会话总在忘记值得记住的东西——周一学到的事实，不该周五重新学一遍。现在跨会话携带 560 条知识。
- **上下文管理**，是因为窗口会满——会话现在会自我压缩、打检查点、自动恢复。
- **联网能力**，是因为与互联网隔绝的 agent 无法感知世界。
- **26 个自定义工具**，是一个一个长出来的——每一个都是昨天摩擦的答案，不是设计文档里的一行。
- **行为反思**，是因为同样的错误会重复犯——Novus 现在会盯着自己的模式（过度调工具、重复调用）并自我纠正。

每个功能的存在，都是因为使用它的 agent 需要它。维护者的工作，大部分是点头。

你会发现这里没有插件市场，也没有现在业界流行的「skills」体系。这是刻意的设计，不是遗漏：插件机制，本质是给「不能自己长出能力」的系统的补偿方案——而 Novus 能自己长。从种子长成的树没有接缝，拼起来的东西有。也许某天某个能力真的长不出来，那时再谈插件。到目前为止，还没有过这种情况。

## 哲学

1. **Agent 才是产品，不是 App。** 没有窗框，没有 Electron——一个 REPL 和一个 HTTP 服务器。
2. **记忆不是功能，是地基。** 会忘掉一切的 agent 只是聊天机器人。
3. **不进化就淘汰。** 不能观察并纠正自己行为的 agent 谈不上成长。
4. **哪里都能跑。** 手机就是计算机，请像对待计算机一样对待它。

## 路线图

- [ ] v1.2 — 多节点联邦协议（手机 ↔ 服务器的完整故事，开源）
- [ ] v1.3 — 组织级编排（角色、流水线、辩论模式）

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。新手友好 issue：工具创意、Termux/Android 兼容、文档翻译。

## 许可

Apache 2.0——见 [LICENSE](LICENSE)。基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)（MIT）构建。
