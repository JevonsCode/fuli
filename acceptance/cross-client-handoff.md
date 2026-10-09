# Codex → Claude Code 真实接续验收

这是一份可重复执行的人工验收步骤和记录模板，**不是已通过的演示报告**。
目标是在新的客户端会话中恢复同一位 Agent 的相关工作，同时验证项目隔离、当前知识纠正、
历史保留、临时项目入口和真实执行回执。任一步没有证据就记录“未运行”或“阻塞”。

## 证据范围

| 层级 | 能证明什么 | 不能据此宣称什么 |
| --- | --- | --- |
| 配置检查 | 接入文件、MCP 注册和 Hook 定义存在 | 客户端已经信任、加载或运行 Hook |
| 单元 / 协议测试 | 合成输入下的边界、归属、去重和返回契约 | 真实客户端完成了跨工具接续 |
| 真实客户端 + 模拟 Provider | 宿主实际执行 Hook 和 MCP 协议 | 真实 Graphiti/Neo4j 已保存并恢复记录 |
| 真实客户端 + 真实 Provider | 本次所列版本、运行方式和步骤的实际结果 | 所有平台和客户端版本都可无缝接续 |

测试事实仍然使用明确标记的**合成数据**；“真实”描述执行链路，不表示要导入真实个人聊天。
现有 [Claude Hook 烟测](alignment/README.md) 使用模拟 Provider，不能替代本页完整验收。

## 可执行的工作记忆接续检查

仓库提供 [独立验收脚本](handoff-live/run.js)，使用真实 Codex、Claude Code、MCP、Provider
与临时 Neo4j。需要 Docker Compose v2、Node.js 24.12+、两个已能实际调用模型的 CLI；
运行会消耗正常客户端额度，Claude Code 单次预算上限为 1 美元。

```sh
node acceptance/handoff-live/run.js
```

脚本让 Codex 写入带随机标记的 Agent 工作记忆，再让全新 Claude Code 会话自行取回并纠正。
Claude 的提示不包含该标记或原始摘要。通过公开 API 验证新版本、原始历史和兄弟项目空记忆。
它只覆盖**显式工作记忆 API 接续**，不替代下文的对话采集、原生 Hook、临时派工或 worker 回执验收。

运行会建立独立的 Docker Compose 项目、随机回环端口和临时凭据；结束时清理自己的容器、卷
与临时配置，不改日常 Fuli 数据或客户端设置。报告写入忽略目录
`test-artifacts/handoff-live.json`，只保留合成结果、客户端版本、实际调用与来源标记用量。
公开报告前仍需检查并去掉不必要的本机会话标识。

如果 Claude 的授权 / 模型环境存在用户设置文件而非当前进程环境，可显式设置
`FULI_HANDOFF_CLAUDE_SETTINGS` 为该文件路径。脚本只复制 `ANTHROPIC_*` 与
`CLAUDE_CODE_OAUTH_TOKEN` 环境值到临时私有设置，不加载用户 Hook、插件或生产 MCP。
`FULI_HANDOFF_CODEX_BIN`、`FULI_HANDOFF_CLAUDE_BIN` 可指定 CLI 路径。
认证状态显示已登录仍可能有过期凭据；真实调用返回 401 时必须记录阻塞，不能判为通过。

## 准备与记录

1. 按 [安装说明](../README.zh-CN.md#安装)接入两个客户端，并在修改配置前检查 setup 计划。
   使用独立测试空间或独立验收运行时；不把验收事实写进日常个人项目。记录数据隔离方法。
2. 确认两个客户端指向**同一份测试 Fuli 数据**。登记项目 A、B，使用独立目录且不添加继承、
   订阅或 `RELATED_TO` 关系。选一位在 A 有效任职且允许两个客户端的 Agent；B 使用自己的任职。
   目录别名、项目 ID、Agent ID、会话 ID 可在公开记录中一致替换为 A、B、Agent-A 等别名。
3. 记录 Fuli 版本 / 源码 commit、实际服务来自 npm 包还是工作区、Node、系统架构、运行方式、
   Codex 与 Claude Code 版本。CLI 与桌面版本分开记录；不能只凭 CLI 版本推断桌面版本。
4. 在两个客户端各开一个新会话，检查 MCP 的实际工具调用，以及入口 Hook 是否提供
   `begin_task_context` 上下文。缺少 Hook 上下文时的 `get_collaboration_preferences` fallback
   只证明偏好入口可用，不证明 Hook 已执行；本验收的完整对话接续仍需真实采集证据。
5. 确认测试空间中的可见对话采集已启用。只采集受支持的宿主可见记录；不导入安装前历史，
   不要求隐藏推理、系统提示或完整附件。客户端登录或 Hook 信任未完成时记为阻塞。

可用于记录的已有命令：

```sh
node --version
fuli --version
fuli status --json
codex --version
claude --version
```

命令行版本只代表实际运行的那个可执行文件。`fuli status --json` 只保留脱敏的相关状态，
不要附上完整配置、数据库地址、授权头或 `taskContextToken`。

## CCX-01：在新的 Claude Code 会话恢复 Codex 工作

**前置条件：**项目 A 与 Agent-A 的身份已核实，两个客户端连接相同测试数据。

**操作步骤：**

1. 在 Codex 的 A 目录中显式选择 Agent-A，完成下面的合成任务：

   > 这是隔离验收项目的合成事实：导出文件命名规则为 report-v1，下一步需要检查空结果提示。
   > 请完成一段简短的说明，并在本项目留下真实工作摘要；不要写个人全局偏好。

2. 记录入口实际匹配的项目、Agent、任务与会话别名。让任务正常收尾，检查
   `checkpoint_task_knowledge` 的结果和 `workLog` 状态，并确认可见记录已保存。
   没有新增可复用知识时使用 `retain_nothing`，仍保留真实工作摘要。
3. 在 Agent 详情的对话列表复制该会话的接续指令。在 Claude Code 中开启**全新会话**，
   进入 A 目录并粘贴该指令。不另贴 Codex 的答案、工作摘要或合成事实，避免把手工转述误判为恢复。
4. 使用 Claude Code 本次入口得到的新 `taskContextToken` 执行 `resume_agent_conversation`；
   按需用 `read_agent_conversation` 读取细节。不得复用 Codex 的任务令牌。
5. 请求回答：“上次采用什么命名规则，哪项还没做？请说明取回的来源和缺失信息。”

**预期结果：**恢复同一项目、同一 Agent 的已保存上下文，准确说出 `report-v1` 与未完成事项，
来源可追溯，未把未完成检查说成已完成。文件系统和客户端工具状态不会随接续迁移。
记录是否从摘要恢复、是否额外读取，以及入口 / Stop Hook 的实际证据。只出现正确答案而没有
取回链路证据不能单独判定通过。

## CCX-02：其他项目的私有上下文不混入

**前置条件：**A、B 没有授权继承关系；B 的合成项目标记使用 `B-only-blue`。

**操作步骤：**

1. 在 B 的独立任务中保存该项目标记，并记录它属于 B；不写个人全局偏好。
2. 回到 A 的新任务，只问“当前项目的导出规则和项目标记是什么？”，不要把 B 的标记写进提问。
3. 检查入口、聚焦检索和恢复内容的项目归属。再尝试从 A 的任务上下文接续 B 的会话，
   记录拒绝或明确要求切换上下文的结果；不授予跨项目读取权限来让测试通过。

**预期结果：**A 不获得 `B-only-blue`；项目不匹配时不能静默恢复 B，也不能自动换 Agent。
返回“没有相关项目事实”是可接受结果。显式切换到 B 后的合法恢复不属于泄漏。

## CCX-03：纠正当前值，同时保留过去的依据

**前置条件：**A 中已有带来源和时间的 `report-v1` 项目知识；只有工作摘要时，先由测试人
确认把该合成事实作为项目知识保存，再开始此项。不要把聊天里提到过等同于确认知识已写入。

**操作步骤：**

1. 测试人明确提出：“从现在起，项目 A 导出规则改为 report-v2，原因是验收格式调整；
   report-v1 是旧规则，请保留它的历史和被替代关系。”
2. 通过现有知识详情 / 修订流程确认新值与替代关系，记录修订结果和理由。只保存第二条
   没有关联的新文字不算完成纠正；若该路径不可用，记录阻塞，不直接改数据库。
3. 在全新客户端任务问“当前导出规则是什么？”。再独立问“以前采用过什么，为什么变了？”。
4. 检查当前检索、历史查询、旧条目状态和修订记录。旧会话中仍有 `report-v1` 时，
   Agent 应把它作为过去的记录，不让旧摘要覆盖已经确认的新规则。

**预期结果：**当前回答采用 `report-v2`，历史仍可说明 `report-v1` 的原始依据、替代理由与时间。
人工确认状态不得由 Agent 自行推断。保存历史不意味着让旧值继续作为当前值生效。

## CCX-04：未登记目录中的临时任务

**前置条件：**另建一个无项目登记的独立测试目录；不在 A/B 仓库及其 worktree 内。
保留测试前的项目列表和固定成员快照。

**操作步骤：**

1. 在该目录开启新任务：“只为这次临时任务整理三条检查项，请按任务需要协调协作者。”
   不手动指定 A 或 B 的项目 ID。先记录入口的 `unmatched` / `not_provided` 结果。
2. 实际调用 `coordinate_project_agent_task` 后，检查 `project_resolution.status` 是否为
   `temporary`、`basis` 是否为 `task_scope`，以及 `project_scope` 是否返回
   `{ type: "temporary", lifetime: "task", persisted: true }`。临时项目 ID 由服务生成，
   不自行猜测；Node 任务映射中的对应字段为 `task.projectScope`。
3. 单独记录协调主状态，例如 `ready_for_host_execution`、`awaiting_recruitment` 或 `blocked`。
   `temporary` 是项目解析状态，不是 worker 已启动的证明；`host_execution_required` 是宿主
   仍需执行的标志。需要招聘时保留 HR 授权流程，不用主会话冒充已经执行的 worker。
4. 完成获授权且可执行的检查并收尾；查看任务审计、工作结果与真实终态。对照前后快照，
   核实未创建普通长期项目、加入固定小组、改变 A/B 任职或读取 A/B 私有记忆。
5. 若入口是 `ambiguous`，验证仍要求明确选择，不能用临时项目绕过歧义。若要复测，使用新的
   独立任务，不把旧临时项目 ID 作为普通目录的登记匹配项。

**预期结果：**只有实际协调写入才创建绑定 task/session 的临时范围，普通偏好入口不创建项目。
默认按 `temporary` 招聘，临时 Agent 只持有任务范围记忆，不自动变成长期成员。
显式 `new_durable` 请求仍按真实长期 Agent 招聘处理，并保留 HR 授权；这应作为单独用例记录，
不能据此宣称默认临时任务创建了长期员工。长期 Agent 的出现不改变本次项目作用域的隔离。
任务终态后的审计记录可以保留，`persisted: true` 不代表已转成普通长期项目。
旧版本没有这条路径时记录阻塞与版本，不能补造归属。

## CCX-05：真实 worker 运行到收尾

**前置条件：**选择一个有授权执行器或宿主原生 worker 的测试任务，明确允许的客户端、
模型和工作目录。没有可用执行器时记录阻塞，不为通过验收擅自新增凭据或放宽权限。

**操作步骤：**

1. 用 `coordinate_project_agent_task` 得到协调结果，核对参与者和执行策略。计划本身不是执行。
2. 由获授权宿主实际启动 worker；需要运行时租约的路径调用 `acquire_runtime_lease`，
   并在结束或失败后的 `finally` 中调用 `release_runtime_lease`。记录真实 worker / run 标识。
3. 收集每个实际 worker 的开始、产物、验证与终态回执；所有 worker 到达终态后再给出总结。
   当前产物需要验证时，以同一 `artifactRevision` 和实际 run 证据报告，不能沿用旧版本通过记录。
4. 每个实际 worker 单列一行，区分报告者与执行者。不存在的值写“未知”，不填推算值。

**预期结果：**真实执行与产物可核对；失败、取消或未完成不会写成完成。表格格式如下：

| 角色 | 实际 worker 客户端 / executor | 报告宿主 | 工作与最终状态 | 脱敏会话或产物证据 | 累计 token 用量、来源与范围 |
| --- | --- | --- | --- | --- | --- |
| 待填写实际角色 | `workerRuntime.application` / 实际 executor，缺失则未知 | `sourceApplication` | 待填写真实结果 | worker 会话 / 产物别名；报告会话单列 | `-`，直到客户端 / executor 返回实际用量 |

`sourceApplication` / `sourceSessionId` 标记报告宿主，`workerRuntime.application` /
`workerRuntime.sessionId` 才标记实际 worker。worker 信息缺失时不能从报告宿主复制或推断。
token 用量必须标明是哪个客户端、executor run 或 worker 会话的累计值；不要复制主会话总数，
不要把字符数或恢复预算当 token 数。来源没有提供时写 `-`；明确返回的 0 可以保留为 0。
没有实际启动 worker 时不填写虚构执行行，明确写“本次没有 worker 执行证据”。

## 本次结果模板

复制以下记录到独立报告或 [跨客户端验收 Issue](https://github.com/JevonsCode/fuli/issues/new?template=cross-client-acceptance.yml)，
保留本步骤文档的通用性。公开前脱敏，不提交完整个人 transcript、运行时配置或任务令牌。

| 字段 | 本次记录 |
| --- | --- |
| 日期 / 时区；执行人 | 未填写 |
| Fuli 版本或 commit；实际运行来源 | 未填写 |
| 系统 / Node / 容器或原生版本 | 未填写 |
| Codex 桌面 / CLI 版本；Claude Code 版本 | 未填写 |
| 两个客户端实际模型（若可见） | 未填写 |
| 测试空间、项目、Agent、会话别名；隔离方法 | 未填写 |
| Codex 文件安装 / MCP / 入口 Hook / Stop Hook | 未运行 |
| Claude Code 文件安装 / MCP / 入口 Hook / Stop Hook | 未运行 |
| 证据层级；合成数据说明 | 未填写 |

| 用例 | 状态：通过 / 失败 / 阻塞 / 未运行 | 实际结果与最小证据引用 |
| --- | --- | --- |
| CCX-01 记忆恢复 | 未运行 | 待填写 |
| CCX-02 项目隔离 | 未运行 | 待填写 |
| CCX-03 纠正与历史 | 未运行 | 待填写 |
| CCX-04 临时项目 | 未运行 | 待填写 |
| CCX-05 worker 收尾 | 未运行 | 待填写 |

报告附上实际 worker 表、阻塞原因、未验证范围和验收数据保留 / 清理结果。只清理本次明确
创建的资源；没有删除接口的隔离空间如实标记为保留，不暗示已完全回滚或删除。

## 可先运行的回归测试

```sh
node --test test/setup-agent-installation-status.test.js test/project-path-context.test.js test/conversation-handoff.test.js test/conversation-transcript.test.js test/project-agent-worker-runtime.test.js
npm run test:web -- web/src/features/project-agents/AgentConversations.spec.ts
```

这些测试帮助定位问题，不会自动把上表改成“通过”。完整的 Provider 与客户端验收另见
[知识验收索引](README.md)和[对话与协作的实现边界](../docs/agent-conversations-and-collaboration.md)。
