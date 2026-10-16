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
2. **固定模型与推理强度（区分 `requested` 与 `actual`）**：
   - 支持的推理强度枚举为 `default | low | medium | high | max`（对齐底座 `src/agent-tools/project-agent-definitions.js` 与 `graph-provider/fuli_graph/project_agent_models.py`）。
   - 采集时必须将**请求值**（`requested_model`、`requested_effort`）与**运行日志实际生效值**（`actual_model`、`actual_effort`）分列记录。
   - **严禁将 `requested` 配置直接抄写或冒充为 `actual`**：若客户端或运行日志未显式回报实际执行的模型标识或实际生效的 `effort` 档位，对应的 `actual_model` / `actual_effort` 必须填写 `未知`（`unknown`）。
3. **固定初始状态与会话/服务启动态（Session & Local Service Start State）**：
   - 使用与日常个人空间隔离的测试空间（`personal_space_id`）；
   - 记录任务开始前目标项目的有效偏好条数（如 `0` 条 vs `20` 条 vs `>150` 条触发恢复）、目标 Agent 的 `memory.revision` 初始值（如 `revision=0`）、以及运行模式（`container` / `native`，Neo4j `balanced` / `low`）；
   - 独立记录**会话启动态**（`session_state`：`fresh_session` 全新会话首轮 vs `same_session_followup` 同会话后续轮次）与**本地服务启动态**（`service_start_state`：`provider_neo4j_cold_wake` 服务/数据库刚唤醒首轮 vs `provider_neo4j_warm_resident` 服务/数据库已常驻热态）。
   - **严禁将会话/服务启动态直接等同于模型缓存状态**：全新会话或 Provider / Neo4j 刚唤醒时，若共享静态系统提示词或工具定义前缀，模型侧仍可能命中 Prompt Cache；反之亦然。
4. **区分模型 Prompt 缓存读取态与缓存写入（Model Cache Read State vs Cache Creation）**：
   - **模型缓存读取态（`model_cache_read_state`）**仅按客户端/执行器暴露的缓存读取命中计数器（`cached_input_tokens` 或 `cache_read_input_tokens`）严格判定：
     - **`cold`**：缓存读取命中为 0（`cached_input_tokens == 0` 或 `cache_read_input_tokens == 0`）；
     - **`warm`**：缓存读取命中大于 0（`cached_input_tokens > 0` 或 `cache_read_input_tokens > 0`）；
     - **`unknown`（`未知`）**：客户端或执行器未暴露缓存读取命中计数器。
   - **缓存写入独立记录（`cache_creation_input_tokens`）**：首轮请求即使产生 `cache_creation_input_tokens > 0`，只要 `cache_read_input_tokens == 0`，其模型缓存读取态仍为 `cold`（仅发生了缓存写入，未发生缓存读取命中），不得记为 `warm`。
   - **分列汇总要求**：`cold`、`warm`、`unknown` 样本必须分列统计，不得直接平均后报告单一成本。

### 2.2 成本与调用指标采集口径（严禁字节估算）

- **唯一合法来源**：客户端或执行器输出的真实结构化运行日志，例如：
  - **Codex CLI**（`codex exec --json`）：从 `turn.completed.usage` 读取 `input_tokens`、`cached_input_tokens`、`output_tokens`（及可见时的 `reasoning_tokens`），从 `item.completed`（`item.type === "mcp_tool_call"`）统计工具名称与成功次数（参见 [`acceptance/handoff-live/clients.js`](./handoff-live/clients.js)）。
  - **Claude Code CLI**（`claude -p --output-format stream-json --verbose`）：从 `result.usage` 读取 `input_tokens`、`cache_creation_input_tokens`、`cache_read_input_tokens`、`output_tokens`，从 `tool_use` / `tool_result` 事件统计实际 MCP 调用。
  - **Provider / MCP 耗时**：从客户端事件时间戳或受控运行器起止时间记录端到端 `duration_ms` 与单次工具 `latency_ms`。
- **禁止估算铁律**：
  - **严禁**使用 JSON 响应字节数（如 `Buffer.byteLength`）、字符长度或除以固定系数（如 `bytes / 4`）推算 Token 数或费用。
  - **严禁**将客户端界面显示的会话上下文占用百分比或账户剩余配额百分比折算为本次任务的 Token 消耗。
  - 凡客户端日志未输出的字段（如不返回 `reasoning_tokens`、不返回 `cache_creation_input_tokens`、不返回实际生效 `effort`、不返回美元账单、或客户端界面不显示剩余额度），**一律填写 `未知`（`unknown`）**；日志明确返回 `0` 的字段保留为 `0`。

### 2.3 单次任务成本采集表模板

| 采集批次 / 时间 | 客户端与版本 | `requested` 模型 / Effort（`default\|low\|medium\|high\|max`） | `actual` 模型 / Effort（未暴露填 `未知`） | 会话与服务启动态（`session_state` / `service_start_state`） | 模型缓存读取态（`cold` / `warm` / `unknown`） | 初始状态（偏好数 / memory rev） | 实际 MCP 工具调用序列（次数） | `input_tokens` | `cache_read_input_tokens`（或 `cached_input_tokens`） | `cache_creation_input_tokens` | `output_tokens` | `reasoning_tokens` | 端到端耗时 `duration_ms` | 日志证据来源 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 待填写 | `codex` / `claude_code` / 其他 | 例：`gpt-5.4` / `high` | 例：`gpt-5.4` / `未知` | `fresh_session` / `provider_neo4j_warm_resident` | `cold` / `warm` / `unknown` | 例：`prefs=10, rev=0` | 例：`begin_task_context(1) -> checkpoint_task_knowledge(1)` | 真实值或 `未知` | 真实值或 `未知` | 真实值或 `未知` | 真实值或 `未知` | 真实值或 `未知` | 真实毫秒数 | `turn.completed` / `result.usage` |

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

## 4. 当前基线快照（2026-10-16 · Base `7579849` / PR `#16` `#17` `#19` `#20`）

以下记录截至 `2026-10-16` 在本机已实际核实的证据与阻塞边界（**未验证栏位均保持显式 `未运行` 或 `阻塞`，不冒充全绿**）：

### 4.1 四栏状态汇总表

| 验收项 | 1. 源码测试（已核实证据） | 2. 宿主触发 | 3. 模型接收 | 4. 真实数据库写回 | 当前责任与状态 |
| --- | --- | --- | --- | --- | --- |
| **P0-AC-01 普通对话写回** | `test/agent-tools.test.js`（5/5）、`test/mcp-integration.test.js`（3/3）通过，并在 PR `#20` head（`6928662`）复验 `test/conversation-transcript.test.js`（12/12）通过 | Google Antigravity 端：`阻塞（blocked）`；Claude Code CLI（`13:13:43`）：实测已触发 `UserPromptSubmit` Hook 并投递上下文；Cursor CLI（`2026.10.14-0f9edde`）：隔离 `HOME` 下 Hook 执行器退出码 `2`（`blocked`）；Codex CLI（`13:45–13:46`）：无 Hook 模式实跑 | **阻塞（`blocked`）**：Claude Code CLI 因网关令牌过期返回 `401`；Codex 实际模型收到 `get_collaboration_preferences` 返回 `native_session_required`（无任务准入），后续 capture 写入才因审批策略（`approval-policy-never`）被拒绝；Cursor 真实实验模型误称已记住 AURORA-C1，但无 task/write receipt | **阻塞（`blocked`）**：均未达成真实闭环写回——Codex 因审批拒绝诚实未写回；Cursor 数据库记录为 0 且无 task/write receipt（口头误称记住而实际未保存，CO-27/29）；两者均未完成正常 task/checkpoint/continuity 链路 | 已分别定位各端真实宿主失败阶段（见 4.2 诊断记录），待刷新网关凭据或具备原生会话与审批后复跑并由 `JVS-AA` 独立核验 |
| **P0-AC-02 换端同负责人接续** | `test/provider-task-context-registry.test.js`（12/12）通过 | Google Antigravity 端：`阻塞（blocked）`；Codex ↔ Claude Code 原生跨端接续：受上述 `401` 与无 Hook 会话限制暂为 `阻塞（blocked）` | `阻塞（blocked）`（待 `C1` 双端真实模型闭环通过） | `阻塞（blocked）`（待 `C1` 双端真实模型闭环通过） | 同上（等待 `C1` 真实客户端闭环完成后独立验收） |
| **P0-AC-03 偏好完整恢复** | PR `#16`（`793ecf0`）Node `test/task-preference-reader.test.js`（8/8）、`test/create-mcp-server-contract.test.js`（22/22）通过，GitHub Actions `provider` 单元测试通过（workflow run `38851403642` / job `116813187753`：`635 passed, 176 skipped`，默认 CI 未挂 Neo4j 服务故跳过 `*_neo4j.py`）；PR `#19`（`5565c49`）GitHub Actions `provider` 单元测试通过（workflow run `38856269264` / job `116828316482`：`635 passed, 176 skipped`） | 原生宿主触发：`未运行` | 原生模型接收：`未运行` | **隔离真实 Neo4j `5.26` 契约已独立实跑通过**：PR `#16` 由 `JVS-ACC` 在本地隔离 Neo4j 实跑 `811 passed`（`JVS-AA` 完成源码审查与 Node `45/45` 复验）；PR `#19` 由 `JVS-AC` 本地隔离 Neo4j 实跑 `17 passed` + `1/1` stdio→HTTP→Neo4j，并由 `JVS-AA` 在独立一次性 `neo4j:5.26-community` 容器复验 `test_worker_run_claim_seal_and_own_context_survive_retries_and_parent_next_turn`（`1 passed in 20.75s`）。真实客户端驱动写回：`未运行` | 源码与本地一次性容器真实 Neo4j `5.26` 契约均已独立验证 PASS；真实客户端宿主闭环待验 |
| **P0-AC-04 分流候选确认** | `test/mcp-integration.test.js`（预览一次性令牌守卫 3/3）通过 | 原生宿主触发：`未运行` | 原生模型接收：`未运行` | 确定性脚本 `npm run test:knowledge:live` 可独立运行；本次未重跑真实客户端 | 待结合真实客户端会话补采 |

### 4.2 本机客户端环境、额度窗口与真实宿主诊断记录（2026-10-16）

| 客户端 | 标识 | 当前 MCP / 会话状态 | 可见额度 / 窗口读数（含窗口名称与时间戳） | 真实 Token / 成本采集状态 | 证据与阻塞 / 失败诊断说明 |
| --- | --- | --- | --- | --- | --- |
| **Google Antigravity** | `JVS-AA`（`Gemini 4 Argon High`） | **阻塞（`blocked`）**：`~/.gemini/config/mcp_config.json` 已恢复 `fuli` 条目（对应 UI 状态 `Connected` / `已接入`），但因会话启动（`11:54+08:00`）时该文件为空，存量会话未热加载 `fuli` MCP 工具声明 | `未知`（客户端界面未向模型暴露账户配额比例或重置窗口） | `未知`（当前会话无法发起原生 `fuli` 工具调用，且不输出结构化 Token 账单） | 严格遵守隔离边界：不读取认证缓存、不复制其他客户端凭据、不用字节数估算 Token |
| **Claude Code** | `JVS-ACC` | CLI Hook 可触发；真实模型网关待刷新凭据 | 截至 `2026-10-16 ~13:55+08:00`：<br>• **5 小时计划窗口（5-hour plan window）**：已用 `83%` / 剩余 `17%`（`16:40+08:00` 重置；此前协调同步剩余 `72%` → `66%` → `49%` 均属该 5 小时计划窗口，非会话上下文窗口）<br>• **周窗口（weekly window）**：已用 `11%`<br>• **当前会话上下文窗口（session context）**：`70%` | 待网关令牌刷新后从 `--output-format stream-json` 的 `result.usage` 采集固定任务配对样本 | **真实宿主诊断（`13:13:43+08:00`）**：真实 CLI 运行已触发 `UserPromptSubmit` Hook 并投递上下文，但模型请求返回 `401`（网关令牌需人工刷新），未产生模型接收与数据库写回 |
| **Codex** | `JVS-AC` | 总协调会话可运行；无 Hook 独立 CLI 诊断已执行 | 由宿主会话管理（未在本文档跨端猜测） | 已留存 1 份**失败诊断样本**（`Temp/fuli-codex-c1-native-20261016.jsonl`），**不作为配对成本基线** | **真实宿主失败诊断样本（`13:45–13:46+08:00`）**：无 Hook 模式实跑真实模型，收到 `get_collaboration_preferences` 返回 `native_session_required`（无任务准入），后续 capture 写入才因原生审批策略拒绝（`approval-policy-never`），诚实未写回；非原生完整闭环，不重复空跑烧 Token |
| **Cursor CLI** | `2026.10.14-0f9edde` | 隔离 `HOME` 下 Hook 执行器阻塞；另存 C1 实验对比样本 | `未知` | 未采集有效基线（非原生闭环） | **真实宿主诊断**：PowerShell UTF-8 BOM 管道解析缺陷已在 PR `#20`（`2c2e503` / `6928662`，待合并）修复并经真实 `powershell.exe` 复验；在隔离 `HOME` 下 Cursor CLI 自身 Hook 执行器以退出码 `2`（`blocked`）中止。此前 Cursor C1 真实实验中模型误称已记住 AURORA-C1，但数据库为 0 且无 task/write receipt（CO-27/29），属伪记忆/未写回，非原生闭环 |

### 4.3 已实测的本地源码契约基准耗时（仅作开发机测试耗时参考，非模型 Token 成本）

- **测试环境**：Windows · Node.js `v24.18.0`（无 hook 原生依赖解析，417 npm 包）
- **实测结果**（`2026-10-16 13:07+08:00`，针对 `793ecf0862628dcf5a94673ff52d406e48862bf3`）：
  - `node --test test/task-preference-reader.test.js test/agent-tools.test.js test/create-mcp-server-contract.test.js test/provider-task-context-registry.test.js test/mcp-integration.test.js`：**45/45 通过，总耗时 `2897.6ms`**（其中含 3 个 stdio MCP 子进程集成用例，单用例耗时 `527.9ms`–`1510.3ms`）。
  - **边界声明**：上述毫秒数仅为本地 Node 进程与 stdio MCP 契约测试耗时，**不包含真实 Graphiti/Neo4j 图查询耗时或真实大模型推理耗时/Token 消耗**。
