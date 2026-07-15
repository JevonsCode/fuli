# 复利 README 重写实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把根 README 重写为一份普通用户先看懂、开发者随后能运行和参与开发的准确项目说明。

**Architecture:** README 采用“产品说明 + 开发者手册”两层结构。前半部分建立产品心智模型和真实工作流，后半部分给出已验证的 Web、CLI、MCP、架构与开发参考，并把未实现能力集中标为规划中。

**Tech Stack:** Markdown、Mermaid、Node.js 24、SQLite、MCP SDK

---

### Task 1: 重写根 README

**Files:**
- Modify: `README.md`

- [x] **Step 1: 核对当前可执行入口**

Run:

```bash
node src/cli.js --help
node src/mcp-server.js --tools
```

Expected: CLI 输出当前命令，MCP 输出 16 个工具；所有 README 示例只使用这里真实存在的入口。

- [x] **Step 2: 按批准的信息架构重写 README**

README 必须依次包含：一句话定位、问题与理念、真实工作流、当前状态、五分钟运行、Agent 接入、架构图、数据边界、Web/CLI/MCP 参考、项目结构、规划中能力、文档与许可证。

必须明确：

```text
已实现：SQLite Personal Runtime、四区本地控制台、CLI、标准 MCP、Personal Lens、候选审核、安全 Outbox、Workspace Protocol v1 contract。
规划中：fuli setup、fuli deploy、远程 Workspace Provider、PostgreSQL、OIDC、OpenFGA、local/remote sync。
```

- [x] **Step 3: 验证 README 没有失效描述或虚假命令**

Run:

```bash
rg -n "capture、search|fuli setup|fuli deploy" README.md
```

Expected: 不出现旧 Web 描述或占位符；规划命令如出现，必须位于“规划中”上下文。

- [x] **Step 4: 验证命令与完整测试**

Run:

```bash
node src/cli.js --help
node src/mcp-server.js --tools
npm test
git diff --check
```

Expected: CLI 与 MCP 命令成功，MCP 工具数量为 16，完整测试零失败，Git 差异无空白错误。

- [x] **Step 5: 提交 README**

```bash
git add README.md docs/superpowers/plans/2026-07-12-readme-redesign.md
git commit -m "docs: rewrite project readme"
```
