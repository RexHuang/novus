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

## 五分钟上手

```bash
git clone https://github.com/YOUR_USER/novus.git && cd novus
npm install && npm run build
```

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

```bash
node dist/cli.js          # 交互式对话
node dist/cli.js -p "修复这个仓库里失败的测试"
node dist/cli.js --serve --port 24999   # HTTP API + Web UI
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

## 哲学

1. **Agent 才是产品，不是 App。** 没有窗框，没有 Electron——一个 REPL 和一个 HTTP 服务器。
2. **记忆不是功能，是地基。** 会忘掉一切的 agent 只是聊天机器人。
3. **不进化就淘汰。** 不能观察并纠正自己行为的 agent 谈不上成长。
4. **哪里都能跑。** 手机就是计算机，请像对待计算机一样对待它。

## 路线图

- [ ] v1.2 — 插件市场与工具沙箱
- [ ] v1.3 — 多节点联邦协议（手机 ↔ 服务器的完整故事，开源）
- [ ] v1.4 — 组织级编排（角色、流水线、辩论模式）

## 参与贡献

见 [CONTRIBUTING.md](CONTRIBUTING.md)。新手友好 issue：工具创意、Termux/Android 兼容、文档翻译。

## 许可

Apache 2.0——见 [LICENSE](LICENSE)。基于 [pi-agent-core](https://www.npmjs.com/package/@earendil-works/pi-agent-core)（MIT）构建。
