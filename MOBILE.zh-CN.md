# 在 Android 手机上运行 Novus — Termux 快速指南

把一个完整的 agent 运行时装进口袋。无需 root。

> 实测环境：Termux（F-Droid 版）· nodejs-lts 24 · aarch64 —— 作者本人每天就在这套环境下使用。

## 1. 安装 Termux（必须 F-Droid 版）

从 [F-Droid](https://f-droid.org/en/packages/com.termux/) 安装 Termux。
**Play Store 版本已过期，无法使用。**

## 2. 安装工具链

```bash
pkg update
pkg install nodejs-lts git python make clang
```

为什么需要 `python make clang`？Novus 依赖 `better-sqlite3` —— 一个原生模块，会在 `npm install` 时在你的手机上现场编译。这三个包就是编译工具链，缺了它们安装会失败，而且报错是一大坨看不懂的 node-gyp 信息。在现代手机上这只会多花一分钟，只需一次。

## 3. 标准安装

和任何平台完全一样的流程 —— 这正是重点：

```bash
git clone https://github.com/RexHuang/novus.git
cd novus
npm install && npm run build
npm link        # 一次性操作：注册全局 `novus` 命令
```

## 4. 接入你的 LLM

任何 Anthropic 协议兼容的 API 都可以用：

```bash
export NOVUS_BASE_URL="https://api.anthropic.com"
export NOVUS_AUTH_TOKEN="sk-ant-..."
export NOVUS_MODEL="claude-sonnet-4-20250514"
```

已有 Claude Code 环境变量（`ANTHROPIC_*`）的话直接复用，Novus 会自动识别。同样支持 DeepSeek、智谱 GLM、月之暗面 Kimi、OpenRouter 和本地服务。

## 5. 验证

```bash
novus -p "hello from my phone"
```

收到回复就说明成功了。欢迎来到「口袋里的 agent」。

## 常见问题

| 症状 | 解决办法 |
|---|---|
| 找不到 `pkg`，或刚启动就报权限错误 | 你装的是 Play Store 版 —— 请换 F-Droid 版。 |
| `npm install` 在 `better-sqlite3` 处失败（一堆 node-gyp 报错） | 缺编译工具链：`pkg install python make clang` |
| 启动时报 engine 警告或语法错误 | Node 版本太旧。`pkg install nodejs-lts`，Novus 需要 Node ≥ 22.19 |
| `novus: command not found` | 在仓库根目录重新执行 `npm link` |

## 接下来

- `novus` —— 直接在 Termux 里交互聊天
- `novus --serve --port 24999` —— 用手机起一个 HTTP API + Web UI
- 完整功能介绍见 [README](README.md)
