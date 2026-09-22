# Fuli 工程结构复查清单（0.8.1）

> **English summary:** This checklist captures remaining structure/debt items after a *safe* cleanup PR (`chore/structure-cleanup-0.8.1`). Branding title + `.nvmrc` were fixed; `cleanup_test_project_agents` is gated behind `FULI_ENABLE_TEST_TOOLS=1` on default MCP/HTTP surfaces. Large renames (Graphiti dir), fixture URL migrations, employee/HR/memory deletions, and any Grok Bot adapter work were deliberately deferred.

## 本 PR 已做（安全、可审阅）

| 项 | 说明 |
| --- | --- |
| `AGENTS.md` 标题 | `Compound Interest Engineering Rules` → `Fuli Engineering Rules`（正文规则未改） |
| `.nvmrc` | `24` → `24.12`，对齐 `package.json` `engines.node >=24.12` |
| 生产脚枪 | `cleanup_test_project_agents`：默认 MCP 工具列表排除；HTTP `/api/project-agents/test-cleanup` 默认 404；handler 需 `FULI_ENABLE_TEST_TOOLS=1`；并标为 `destructiveHint` |
| 本清单 | 记录未改项与后续建议 |

启用测试工具（仅本地/CI harness）：

```bash
FULI_ENABLE_TEST_TOOLS=1 fuli …   # 或导出到 MCP/HTTP 进程环境
```

## 已知遗留问题（结构复查）

### 命名双轨 / 历史品牌

- 源码目录仍为 `src/graphiti/`，而 Provider Python 包已是 `graph-provider/fuli_graph/`；compose/脚本里仍见 `graphiti` 命名。
- **不要在本 PR 做** Graphiti→`fuli_graph` 的大规模目录重命名（破坏面过大）。
- 测试夹具仍大量使用 `prd://compound-interest/...` 与个别 `Compound Interest` 产品名字符串（约 20+ 处在 `test/`）。应单独做迁移 PR，勿与结构清理混提。
- `workspace-protocol` 相关测试仍可能用 “Compound Interest” 作为示例空间名——视为历史夹具，列入迁移，而非本 PR 删除。

### MCP 工具面过大

- 当前 `listAgentTools()` 约 **115** 个工具（含测试专用定义）。
- 远程 MCP（`remote-mcp`）已收敛到约 9 个只读/任务工具；stdio 默认面仍接近全量。
- 建议后续：按角色/工作流做 allowlist 分层（类似 `REMOTE_TOOL_NAMES`），而不是继续堆工具。

### Adapter 不对称

- 已有相对完整的 Claude Code / Codex / Cursor 集成路径（hooks、setup、bootstrap）。
- **没有**官方 Grok Bot adapter；本 PR **刻意不**强行加入任何 Grok Bot 集成。
- 跨宿主 hook 覆盖仍有缺口（部分 Agent 的生命周期/检查点路径不对称）。后续按宿主补齐，而不是在 common 层加 Agent 特判。

### 安全与部署

- LAN 访问使用 Basic Auth（用户名固定 `fuli` + 访问码）。强度依赖访问码熵与仅私网暴露；文档中应持续强调不要把 LAN 端口暴露到公网。
- `remote-mcp`：单项目绑定、工具白名单、Bearer；仍有会话数/空闲 TTL 等限制，不适合当作通用公网 MCP 网关。
- `cleanup_test_project_agents` 虽已默认关闭，但 **catalog**（`listAgentTools` / `--tools`）仍可见定义，便于 harness 发现；真正暴露需环境变量。

### 包与构建

- `package-smoke` / `prepack` 依赖 `dist/web`（需先 `npm run build`）。裸 clone 未构建时 smoke 会失败——属预期，可在 CI 文档中写清顺序。
- Box/CI 若仍是 Node 20，而 engines 要求 `>=24.12`：优先用 nvm/fnm 对齐；本清理 PR 不放宽 engines。

### 功能边界（明确不删）

- **不删除** employee / HR / memory 相关能力与文档。
- **不删除** 看起来“可能未用”但无 rg 证据的导出；宁可列在下方“待核实”也不误删。

## 本 PR **刻意未改** 及原因

| 未改项 | 原因 |
| --- | --- |
| `src/graphiti/` → `src/fuli_graph/`（或类似）目录重命名 | 牵涉 import、脚本、compose、文档与外部习惯；应独立破坏性 PR |
| 批量改写 `prd://compound-interest/...` 测试夹具 | 噪音大、易与行为回归搅在一起；单独迁移 |
| 缩减 MCP 115 工具面 / 大改 annotations | 需要产品分层设计，超出“结构清理”范围 |
| 强制 Grok Bot adapter | 超出清理目标；且约束禁止强行集成 |
| 删除 employee/HR/memory | 约束禁止；属于产品能力而非死代码 |
| 全量 `npm test`（若环境 Node&lt;24.12 或未装依赖） | engines 与安装成本；以定向 `node --test` / 语法检查代替并记录 |

## 建议后续（按优先级）

1. **P0**：在发布说明中写明 `FULI_ENABLE_TEST_TOOLS`；确认生产/桌面启动路径未导出该变量。
2. **P1**：规划 `src/graphiti` 命名收敛（目录、`compose.graphiti.yml`、`npm run graph:*`）的破坏性迁移清单与兼容期。
3. **P1**：stdio MCP 工具面分层（默认核心集 + 可选域），降低 Agent 误用面。
4. **P2**：测试夹具 URI/品牌字符串从 `compound-interest` 迁到 `fuli`（含 workspace-protocol 示例名）。
5. **P2**：补齐跨宿主 hook 缺口文档矩阵（Claude / Codex / Cursor / 其他）。
6. **P3**：若产品需要 Grok Bot，另开设计讨论与 adapter 目录（遵循 `AGENTS.md` Agent 边界），勿塞进 common。
7. **P3**：LAN Basic Auth 是否升级为更强方案（或默认拒绝非 loopback）的安全评审。

## 待核实（疑似死代码 / 风险重命名——先观察）

以下未在本 PR 删除；若后续用 `rg` 证明零引用且测试全绿，再小步清理：

- 历史文档中的 deprecated HTTP 兼容说明（见 `docs/claude-code-review-2026-08-31.md`）——可能仍有外部调用方。
- `src/graphiti/*` 与 `graph-provider/fuli_graph/*` 双轨命名本身不是死代码，是债务。
- 任何“只在注释/旧 review 出现”的符号：先搜引用，再决定。

## 验证记录（本清理分支）

在 Node **v24.12.0**（nvm）+ `npm ci --ignore-scripts` 下：

- `node --check`：`src/mcp/test-tools.js`、`create-mcp-server.js`、`graph-handlers.js`、`graph-api-router.js`、`tool-annotations.js` — 通过
- `node --test test/create-mcp-server-contract.test.js test/mcp-server.test.js test/agent-tools.test.js` — **18/18 通过**（含“默认省略 cleanup_test_project_agents”合同测试）
- `node --test test/server-runtime.test.js` — **未作为本 PR 回归依据**：失败原因为缺少 `dist/web`（静态控制台 `Not found`），与本次门控改动无关；完整 HTTP 冒烟需先 `npm run build:web`
- 未跑全量 `npm test` / `mcp-integration`（安装与构建成本）；合入前建议在有 `dist/web` 的 CI 补跑

```bash
node --check src/mcp/test-tools.js
node --check src/mcp/create-mcp-server.js
node --check src/agent-tools/graph-handlers.js
node --check src/http/graph-api-router.js
node --test test/create-mcp-server-contract.test.js test/agent-tools.test.js test/mcp-server.test.js
# 有 dist/web 后：
# node --test test/server-runtime.test.js test/mcp-integration.test.js
```
