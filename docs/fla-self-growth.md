# FLA 自增长：给人看的输出，和自己沉淀工作流与脚本

两条规矩由 FULI 定好并下发，不靠单个模型自觉（Jevons 11-23）：

1. 给人看的东西要清晰明了，有交互的方便交互，能点击的不输入。
2. FLA 长期做某类事就自己沉淀工作流，重复性高的就自己沉淀脚本。

两条都写在公共层，不分客户端。客户端之间的差别（哪个客户端能渲染图、有没有原生选择
组件）由 FLA 在那一刻判断，规矩只说「客户端支持什么就用什么」。

## 一、给人看的输出

### 规矩放在哪

任务入口的规则文本按版本引用、需要时才读全文（`src/conversations/entry-rules.js`）。
`task_guidance` 这一段已经整段压成一个指针
（`fuli://rules/task-entry/task_guidance`），压缩的条件是键的数量和共享文本完全一致
（`src/conversations/task-context-view.js`）。所以在 `taskKnowledgeGuidance()` 里加一个
键，入口每轮的字节数**一个不增**：指针还是那一个指针，只有 `rules_version` 变、资源全文
变长。`test/token-budget.test.js` 盯着这个数。

新键是 `human_facing_output`，和已有的 `human_attention` 并排：一个说什么时候找人，一个
说找人时怎么写。

### 规矩说什么

- 先写结论和要人做的事，再写别的；只写重点。
- 结构能帮人看懂时才用列表或表，不为了好看而列。
- 关系、流程、前后对比用图更清楚时就画图，用客户端渲染得出来的形式（Mermaid、表格、
  链接到控制台的图）。
- 要人做选择时给能直接点的选项：会话里用客户端原生选择（`human_interaction`），人不在
  用 `request_agent_attention` 的 `options`（已支持 2–3 个），两样都没有才给编号选项。
  不让人打字说一个本可以点的答案。
- 链接给能点的完整链接，不给要人自己拼的路径或 ID。
- FLA 在圆桌里发给人看的总结，同一套标准。

### FULI 自己发给人的东西

同一把尺子量 FULI 自己的回执、待拍板请求、通知和更新说明。本轮改掉的、以及留下的，见
PR 描述里的清单。原则：给人看的地方不出现内部代号和英文类型名；一个请求的选项是人能
直接点的、彼此真的不同的几项。

## 二、自己沉淀工作流和脚本

### 现在断在哪

FULI 里零件都有，链条断了三处：

- **发现重复**有两套。图谱那套（`list_workflow_candidates` →
  `graph-provider/fuli_graph/workflow_candidates.py`）靠 `fuli_workflow_session_authority`
  的证据，而唯一写这个证据的 `record_workflow_transition_observation` 已在 11-11 退役
  （`src/agent-tools/retired-tools.js`），所以新装的机器上候选永远是空的。活着的那套是
  `src/fla-growth/tool-suggestions.js`：同一位 FLA 在同一项目的 3 个以上已完成任务里，
  计划步骤序列逐条一模一样（或某个启用的工作流在 3 个任务里按同一版本跑完）。
- **提示沉淀**只提示人，不提示 FLA。上面那套每小时跑一次，向人提一条待拍板问「要做成
  工具吗」；但那位 FLA 自己下次再做同类事时，入口里什么都没有。
- **沉淀出来的东西下次不被带上**。任务入口从不带工作流，这是故意的
  （`docs/agent-interface-architecture.md`）；可是也没有任何规则让模型去调
  `list_agent_workflows`，于是确认过的工作流很可能一次都不被读。
- **「做成脚本」这个选项背后没有东西**。`TOOL_CHOICES` 里有「做成脚本」，但 FULI 里没有
  脚本存储、没有脚本运行入口；只有 Agent 应用这一条真路。

### 做法

**判据**沿用活着的那套，不另起炉灶，也不复活退役的观察工具：同一位 FLA、同一项目、
3 个以上已完成任务里步骤序列完全相同，或一个启用的工作流在 3 个任务里按同一版本跑完。
确定、可解释、不调模型。门槛就用现有的 `MIN_TASKS = 3` / `MIN_STEPS = 3`：少于 3 步的
不算一串活，少于 3 次不算长期做。一次性任务、小任务因此不会命中。

**提示放进入口，不多出待拍板。** 检测到重复时，除了现有那条给人的待拍板，再在
`agent-workflows.sqlite` 里记一行待下发的提示。那位 FLA 在同一项目下一次进任务时，入口
多一个 `fla_growth`：一句话说这类事做了几次、该调哪个工具、最小参数是什么，外加一个
指向 `fuli://rules/task-entry/self_deposit` 的指针（全文在资源里）。下发一次就标记已发，
不重复刷；没有重复时这个键根本不出现，入口字节数不变。只有真正开了任务的入口才会下发，
没有 task token 的那种重复读取不消耗它。

**沉淀成什么、放哪：**

- 步骤 → 工作流，用现有的 `propose_agent_workflow`。保留原有的口径：提出来是
  `proposed`，人在控制台确认才 `active`，`read_agent_workflow` 和
  `record_agent_workflow_run` 都只认 `active`（`src/agent-workflows/port.js`）。
- 反复执行的命令或操作 → 这位 FLA 名下的 Agent 应用（`submit_agent_app_version`，
  `runtime.entry`、不常驻）。**不新造脚本存储**：Agent 应用已经是「FLA 名下、带说明、
  有版本、能跑、留运行记录」的那一件东西，安全边界也已经定死（见下）。
- 工作台：这位 FLA 的工作流、应用和最近运行都在它的 FLA 页上；本轮只做数据和一个独立
  widget（`web/src/widgets/registry.ts` 的 `fla.overview` 槽），由 FLA 页的负责人放进布局。

**脚本的安全边界**（全部沿用现有机制，不放宽）：

- 存在哪：`<dataDir>/agent-apps/packages/<appId>/<version>/`，版本不可变，按摘要定身份。
- 谁能运行：只有本机的人在终端 `fuli app approve <appId> <version>` 里输入应用名确认过
  的那个摘要。控制台点一下不算人确认（`src/agent-apps/run-gate.js`）。
- 运行前人看得到内容：确认的是具体版本的摘要，包文件在确认前就落盘可读。
- 不自动执行别的电脑或别的 FLA 的脚本：运行闸门每次启动都重验，跨电脑的决定一律被
  `refuseRemoteDecision` 拒掉（`src/http/request-policy.js`）；格式更新待确认时的只读会话
  连任务都不记，更不会运行。
- 不把密钥写进脚本：应用能拿到的工具是白名单里的五个，环境变量被清空到
  `FULI_APP_*`（`src/agent-apps/trusted-runner.js`、`host-tools/catalog.js`）。
- 本版本没有系统级沙箱，这一点 `docs/agent-apps.md` 已经写明，本轮不改也不淡化。

**留不留由人定**：工作流沿用「提出 → 人确认」；应用沿用「提交 → 人在终端确认」。都不
改口径。控制台上看得到新沉淀了什么、用过几次；没用上的不显示成在用，没跑过的不显示
结果。发现重复但 FLA 没去沉淀，只是下次再提示一次，FULI 不替它建一个。

## 相关记录

rec#7（员工包与 Agent 应用）、rec#78（FLA 自增长）、rec#80、rec#91、rec#89。
