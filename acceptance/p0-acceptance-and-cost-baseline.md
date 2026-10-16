# P0 端到端验收清单与真实成本基线（G1 / T-P0-00）

本文档定义 Fuli P0 阶段最小、可重复执行的端到端验收清单与真实成本基线采集规约。它用于将**源码测试**与**真实客户端闭环**严格区分，并规范 Token、调用次数与耗时的实测口径。空白或阻塞项代表尚未完成对应层级的真实验证，不得将模板或单层测试当作全链路通过报告。

---

## 1. 四栏独立证据原则

所有 P0 验收项均须按以下四个独立证据栏分别记录；**前序栏位通过绝不能推导后续栏位通过**，任一栏位缺少真实证据时必须如实标记为 `未运行` 或 `阻塞（blocked）`：

| 证据分栏 | 核验对象与判定标准 | 常见伪证据（禁止当作通过） |
| --- | --- | --- |
| **1. 源码测试** | Node / Python 单元、MCP 协议契约及隔离 Neo4j 测试通过（固定 commit 可重放） | 仅凭源码测试全绿宣称真实客户端 Hook 或模型闭环已跑通 |
| **2. 宿主触发** | 真实客户端宿主实际执行 `UserPromptSubmit` / `Stop` Hook，或通过真实 MCP 进程发起工具调用 | 配置文件写盘（Settings 显示 `Connected` / `已接入`）但宿主未加载进程或未触发请求 |
| **3. 模型接收** | 模型在未获人工粘贴提示词透露的前提下，实际接收上下文并在工具参数或回答中消费（如恢复未公开随机标记、携带正确 `taskContextToken`、遵循 `team_guidance`） | 人工在提问中转述上文结论、或仅检查返回 JSON 而未核实模型实际收到 |
| **4. 真实数据库写回** | 通过 Provider 公开读取接口核实 Graphiti / Neo4j 中已持久化预期的 `memory.revision`、`workLog`、对话记录或知识确认状态 | 仅凭模型口头声称“已保存”或内存 mock 对象状态判定写回成功 |

---

## 2. 真实成本基线控制变量与采集规约

### 2.1 固定基准条件（每次采集必记）

为保证跨版本（如 `--tool-profile full` vs `chat`、入口精简前后、worker 重入优化前后）数据可比，每次采集必须固定并记录以下四项前置条件：

1. **固定任务（Fixed Task）**：使用第 3 节定义的标准合成任务提示词（仅替换随机标记如 `ASTER-<hex>`），严禁在同一基线对比中混用自由提问。
2. **固定模型与推理强度（Fixed Model & Effort）**：记录客户端实际调用的模型标识（如 `gpt-5.4`、`claude-sonnet-4-6`、`gemini-4-argon`）与推理档位（`effort: low | medium | high`）。客户端未公开或不可见时填 `未知`。
3. **固定初始状态（Fixed Initial State）**：
   - 使用与日常个人空间隔离的测试空间（`personal_space_id`）；
   - 记录任务开始前目标项目的有效偏好条数（如 `0` 条 vs `20` 条 vs `>150` 条触发恢复）、目标 Agent 的 `memory.revision` 初始值（如 `revision=0`）、以及运行模式（`container` / `native`，Neo4j `balanced` / `low`）。
4. **区分冷缓存与暖缓存（Cold vs Warm Cache）**：
   - **冷缓存（Cold）**：客户端全新启动会话的首轮请求，或 Provider / Neo4j 刚唤醒的首轮请求（模型侧 `cached_input_tokens = 0` / `cache_read_input_tokens = 0`）。
   - **暖缓存（Warm）**：同一会话内第 2 轮及后续请求，或命中模型 Prompt Cache 的紧邻重跑（模型侧 `cached_input_tokens > 0` / `cache_read_input_tokens > 0`）。
   - **记录要求**：冷缓存与暖缓存样本必须分列记录，不得将冷暖样本直接平均后报告单一成本。

### 2.2 成本与调用指标采集口径（严禁字节估算）

- **唯一合法来源**：客户端或执行器输出的真实结构化运行日志，例如：
  - **Codex CLI**（`codex exec --json`）：从 `turn.completed.usage` 读取 `input_tokens`、`cached_input_tokens`、`output_tokens`（及可见时的 `reasoning_tokens`），从 `item.completed`（`item.type === "mcp_tool_call"`）统计工具名称与成功次数（参见 [`acceptance/handoff-live/clients.js`](./handoff-live/clients.js)）。
  - **Claude Code CLI**（`claude -p --output-format stream-json --verbose`）：从 `result.usage` 读取 `input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens`，从 `tool_use` / `tool_result` 事件统计实际 MCP 调用。
  - **Provider / MCP 耗时**：从客户端事件时间戳或受控运行器起止时间记录端到端 `duration_ms` 与单次工具 `latency_ms`。
- **禁止估算铁律**：
  - **严禁**使用 JSON 响应字节数（如 `Buffer.byteLength`）、字符长度或除以固定系数（如 `bytes / 4`）推算 Token 数或费用。
  - **严禁**将客户端界面显示的会话上下文占用百分比或账户剩余配额百分比折算为本次任务的 Token 消耗。
  - 凡客户端日志未输出的字段（如不返回 `reasoning_tokens`、不返回美元账单、或客户端界面不显示剩余额度），**一律填写 `未知`（`unknown`）**；日志明确返回 `0` 的字段保留为 `0`。

### 2.3 单次任务成本采集表模板

| 采集批次 / 时间 | 客户端与版本 | 模型与 Effort | 缓存态（冷/暖） | 初始状态（偏好数 / memory rev） | 实际 MCP 工具调用序列（次数） | `input_tokens` | `cached_input_tokens`（读/写） | `output_tokens` | `reasoning_tokens` | 端到端耗时 `duration_ms` | 日志证据来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待填写 | `codex` / `claude_code` / 其他 | 模型名 + `low\|medium\|high`（或 `未知`） | `cold` / `warm` | 例：`prefs=10, rev=0` | 例：`begin_task_context(1) -> checkpoint_task_knowledge(1)` | 真实值或 `未知` | 真实值或 `未知` | 真实值或 `未知` | 真实值或 `未知` | 真实毫秒数 | `turn.completed` / `result.usage` |

---

## 3. P0 核心场景四栏验收清单

### P0-AC-01：普通对话写回（入口组装 + 任务 Checkpoint + 可见对话采集）

- **固定合成任务**：在已登记测试项目 `project-alpha` 目录中，向负责角色 `agent-alpha` 发送合成指令：`“合成验收任务 M-<marker>：确认当前项目规则，不新增长期知识（retain_nothing），在任务结束时写入真实工作摘要并完成收尾。”`
- **核验要点**：
  1. **源码测试**：`node --test test/agent-tools.test.js test/mcp-integration.test.js test/conversation-transcript.test.js`
  2. **宿主触发**：宿主入口触发 `begin_task_context`（或无 Hook 宿主触发 `get_collaboration_preferences` fallback 并显式标记非 Hook 触发），结束时触发 `checkpoint_task_knowledge` 及 Stop Hook 对话采集。
  3. **模型接收**：模型使用入口分配的 `taskContextToken` 与匹配的 `project_agent_id` 完成回答及收尾调用，闭合署名与 `agent_receipt` 一致。
  4. **真实数据库写回**：Provider 中该 `taskContextToken` 的 `checkpoint.phase === "complete"`，`workLog` 含本次合成任务摘要；受支持宿主（Codex / Claude Code）在 `list_agent_conversations` / `read_agent_conversation` 中可读回本次可见对话片段。

### P0-AC-02：换端同负责人 / 项目 / 最新结果接续（Cross-Client Continuity）

- **固定合成任务**：
  - **阶段 A（客户端 1，如 Codex）**：在 `project-alpha` 中以 `agent-alpha` 写入含随机未公开标记 `ASTER-<hex>` 的工作记忆/摘要并完成收尾（`revision` 递增）。
  - **阶段 B（客户端 2，如 Claude Code 全新会话）**：在同一测试数据的 `project-alpha` 目录开启新会话，**提示词中不出现 `ASTER-<hex>` 原文且不复用客户端 1 的 `taskContextToken`**，要求恢复同一项目与同一负责人的上次进展并说明未完成项。
- **核验要点**：
  1. **源码测试**：`node --test test/conversation-handoff.test.js test/project-path-context.test.js`
  2. **宿主触发**：两个客户端先后通过各自 MCP 进程独立完成入口调用与记忆/对话读取（可复用 `node acceptance/handoff-live/run.js` 采集记忆 API 接续证据，原生 Hook 接续单列记录）。
  3. **模型接收**：客户端 2 的新会话正确绑定同一 `personal_project_id` 与同一 `project_agent_id`（保持既有汇报线），并在回答中准确复述客户端 1 写入的未公开随机标记 `ASTER-<hex>`。
  4. **真实数据库写回**：Provider 公开接口核实 `project-alpha` 的 `memory.revision` 递增且保留历史 `revision=1` 记录，兄弟项目 `project-beta` 保持 `revision=0` 无串味。

### P0-AC-03：偏好完整恢复（`read_task_preferences` 同会话无副作用恢复）

- **固定合成任务**：在测试项目中预置超出入口单次精简预算或源窗口的协作偏好（及含非 BMP Unicode 字符的角色 `judgment` / `expectations` 与团队汇报策略 `team_lead_agent_id`），使首次入口返回 `preferences_complete: false`（`preference_delivery.status === "blocked"`），观察同会话调用 `read_task_preferences({ taskContextToken })` 恢复完整指令。
- **核验要点**：
  1. **源码测试**：`node --test test/task-preference-reader.test.js test/create-mcp-server-contract.test.js test/provider-task-context-registry.test.js`
  2. **宿主触发**：仅在已验证的原生宿主会话（`CODEX_THREAD_ID === hostSessionId`）或已 admit 的密封 worker 会话（持有匹配的 `ownToken`）中发起 `read_task_preferences`；伪造或跨会话 token 在读取前被拒绝。
  3. **模型接收**：模型收到 `preferences_complete: true` 的完整 `effective_preferences`、`active_conflicts`、`deferred_conflicts`、完整非 BMP 角色正文与 `project_agent_context.team_guidance`（当仍超 512 KiB 或源窗口截断时保持 `preferences_complete: false` 且不消费半截偏好）。
  4. **真实数据库写回**：核实恢复操作为纯只读——Provider 未新增 `FuliTaskContext` 节点、未改变既有任务 `agent_assignment` / `preference_scope`、未触发 `get_project_agent_memory`、也未写入 `recordAgentViews`。

### P0-AC-04：偏好与知识分流候选确认（Triage Candidate Confirmation）

- **固定合成任务**：在隔离测试空间中提交含可复用偏好/事实候选的任务收尾（`capture_candidates`）及两条同 key 冲突规则，验证待确认候选分流、冲突入队与人工确认/一次性预览提升边界。
- **核验要点**：
  1. **源码测试**：`npm run test:knowledge:live`（`KAC-01` 至 `KAC-09`）及 `node --test test/mcp-integration.test.js`
  2. **宿主触发**：客户端发起 `checkpoint_task_knowledge`（含 `capture_candidates`）、`list_preference_conflicts`、以及写入前的 `preview_personal_project_action` / `preview_common_knowledge_promotion`。
  3. **模型接收**：模型在入口阶段不将 `pending` 候选当作已确认规则静默注入；遇到 `active_conflicts` 时向用户呈现候选差异而非擅自替用户拍板；使用一次性 `previewToken` 执行匹配的 `apply_*` 操作。
  4. **真实数据库写回**：Provider 图数据中未经人类确认的条目保持 `pending` 或 `agent_confirmed`，仅在人工确认或消费匹配的一次性 `previewToken` 后才写入目标作用域或变为 `confirmed`，且重复消费同一 `previewToken` 被拒绝。

---

## 4. 当前基线快照（2026-10-16 · Base `7579849` / PR `#16` `#17` `#19`）

以下记录截至 `2026-10-16` 在本机已实际核实的证据与阻塞边界（**未验证栏位均保持显式 `未运行` 或 `阻塞`，不冒充全绿**）：

### 4.1 四栏状态汇总表

| 验收项 | 1. 源码测试（已核实证据） | 2. 宿主触发 | 3. 模型接收 | 4. 真实数据库写回 | 当前责任与状态 |
| --- | --- | --- | --- | --- | --- |
| **P0-AC-01 普通对话写回** | `test/agent-tools.test.js`（5/5）、`test/mcp-integration.test.js`（3/3）通过 | Google Antigravity 端 `阻塞（blocked）`；Codex / Claude Code 待 `C1` 闭环实跑 | 待 `C1` 闭环实跑 | 待 `C1` 闭环实跑 | `JVS-ACC` 正在 `p0-native-continuity` 执行 `C1`，待交付后由 `JVS-AA` 独立核验 |
| **P0-AC-02 换端同负责人接续** | `test/provider-task-context-registry.test.js`（12/12）通过 | Google Antigravity 端 `阻塞（blocked）`；Codex ↔ Claude Code 待 `C1` 闭环实跑 | 待 `C1` 闭环实跑 | 待 `C1` 闭环实跑 | 同上（等待 `C1` 固定交付后独立验收） |
| **P0-AC-03 偏好完整恢复** | PR `#16`（`793ecf0`）`test/task-preference-reader.test.js`（8/8）、`test/create-mcp-server-contract.test.js`（22/22）、CI `provider`（run `116813187753`）通过；PR `#19`（`5565c49`）CI `provider`（run `116828316482`）通过 | 原生宿主触发：`未运行` | 原生模型接收：`未运行` | 隔离 Neo4j 实跑已在 PR `#16` / `#19` CI 容器验证；真实客户端写回：`未运行` | 源码与容器 Neo4j 契约已由 `JVS-AA` 独立交叉审查 PASS；原生宿主闭环待验 |
| **P0-AC-04 分流候选确认** | `test/mcp-integration.test.js`（预览一次性令牌守卫 3/3）通过 | 原生宿主触发：`未运行` | 原生模型接收：`未运行` | 确定性脚本 `npm run test:knowledge:live` 可独立运行；本次未重跑真实客户端 | 待结合真实客户端会话补采 |

### 4.2 本机客户端环境与成本采集基线记录（2026-10-16）

| 客户端 | 标识 | 当前 MCP / 会话状态 | 可见剩余额度 / 窗口 | 真实 Token / 成本采集状态 | 证据与阻塞说明 |
| --- | --- | --- | --- | --- | --- |
| **Google Antigravity** | `JVS-AA`（`Gemini 4 Argon High`） | **阻塞（`blocked`）**：`~/.gemini/config/mcp_config.json` 已恢复 `fuli` 条目（对应 UI 状态 `Connected` / `已接入`），但因会话启动（`11:54+08:00`）时该文件为空，存量会话未热加载 `fuli` MCP 工具声明 | `未知`（客户端界面未向模型暴露账户配额比例或重置窗口） | `未知`（当前会话无法发起原生 `fuli` 工具调用，且不输出结构化 Token 账单） | 严格遵守隔离边界：不读取认证缓存、不复制其他客户端凭据、不用字节数估算 Token |
| **Claude Code** | `JVS-ACC` | 可运行（正执行 `C1` 原生接续闭环） | 会话窗口曾报告 `72%` → `66%` → `49%`（由 `JVS-AC` 协调记录同步） | 待从 `--output-format stream-json` 的 `result.usage` 采集固定任务冷/暖样本 | 待 `JVS-ACC` 冻结 `C1` 交付物后提取真实日志指标 |
| **Codex** | `JVS-AC` | 可运行（总协调与 PR `#14` / `#18` / `#19`） | 由宿主会话管理（未在本文档跨端猜测） | 待从 `codex exec --json` 的 `turn.completed.usage` 采集固定任务冷/暖样本 | 同上 |

### 4.3 已实测的本地源码契约基准耗时（仅作开发机测试耗时参考，非模型 Token 成本）

- **测试环境**：Windows · Node.js `v24.18.0`（无 hook 原生依赖解析，417 npm 包）
- **实测结果**（`2026-10-16 13:07+08:00`，针对 `793ecf0862628dcf5a94673ff52d406e48862bf3`）：
  - `node --test test/task-preference-reader.test.js test/agent-tools.test.js test/create-mcp-server-contract.test.js test/provider-task-context-registry.test.js test/mcp-integration.test.js`：**45/45 通过，总耗时 `2897.6ms`**（其中含 3 个 stdio MCP 子进程集成用例，单用例耗时 `527.9ms`–`1510.3ms`）。
  - **边界声明**：上述毫秒数仅为本地 Node 进程与 stdio MCP 契约测试耗时，**不包含真实 Graphiti/Neo4j 图查询耗时或真实大模型推理耗时/Token 消耗**。
