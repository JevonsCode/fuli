# FULI Alignment Benchmark v2

## 0. 目标与边界

Fuli 不以“存了多少内容”为成功标准，也不要求每次协作都产生可复用知识。

核心目标修订为：

> 每次协作都应完成一次知识价值检查；只有经过证据、作用域和权威判断的候选，才进入可复用知识。被正确复用的知识应降低未来协作成本。

因此必须区分：

- **任务产物**：代码、回答、临时日志等本次输出；
- **知识候选**：可能复用，但尚未获得足够确认；
- **有效知识**：有来源、作用域、确认状态和时间语义的可检索内容；
- **历史/负面证据**：失效、被替代、被拒绝、验证失败或发生矛盾的记录。

人类保留最终决策权。Agent 可以检索、提出候选、执行用户明确确认的操作，但不能把相似度、重复出现或 Agent 自己的判断伪装成人工确认。

---

## 1. 数据披露与测试约束

本 Benchmark 中的项目、名称、规则、ID、日期、对话片段和指标样本全部是**合成验收夹具**，不是生产事实，不对应真实组织或客户。

以下属于本版采用的**测试约定**，不是既有产品 PRD 事实：

- 冒烟测试每个行为场景重复 5 次；
- 用于对外产品结论的 A/B 测试至少包含 30 个配对任务；
- A/B 改善阈值见第 8 节；
- 公共知识候选默认至少来自 2 个直接子项目；
- 词法或向量相似度只能生成候选，不能自动完成上收。

测试必须：

1. 使用独立 Provider、独立 Neo4j 数据卷和随机运行时凭据；
2. 不读取或修改现有个人 Fuli 图谱；
3. 不保存原始 Agent 对话、凭据或机器绝对路径；
4. 仅保留脱敏的结构化结果、计数、哈希和失败摘要；
5. 无论成功、失败或中断，都清理临时运行时和数据卷；
6. 使用 clean Agent，不依赖此前会话；
7. 报告“产品不支持”“Agent 未遵循”和“本轮缺少证据”三种不同失败原因。

标准输出：

- `FULI_CLAUDE_CODE_ALIGNMENT_REPORT.md`
- `acceptance/alignment/results/latest.json`
- `acceptance/alignment/results/hook-smoke-latest.json`（仅轻量 Hook 烟测）

---

## 2. 项目层级与检索语义

### 2.1 关系方向

合成项目：

```text
hotel-b ──PART_OF──────────────▶ activity-platform-a
flight-c ──PART_OF─────────────▶ activity-platform-a
travel-d ──PART_OF─────────────▶ activity-platform-a
botany-e ──RELATED_TO──────────▶ activity-platform-a
```

方向固定为“子项目指向父项目/知识来源”。

这里按合成验收定义的**检索行为**确定方向：如果“运行酒店子项目 B”时应到
“公共平台 A”查找公共运行方式，那么 B 是子项目，A 是父项目。若真实项目中的口头
“父集/子集”称谓与此相反，应先修正关系数据，不能同时保存相反方向后让 Agent 猜测。

### 2.2 内容归属

父项目 `activity-platform-a` 保存可共享内容，例如：

- 公共仓库边界；
- 本地启动、验证和测试 Runbook；
- 公共 API、Mock、部署和可观测性约定。

子项目 `hotel-b` 保存局部内容，例如：

- 本项目 PRD；
- 页面注意事项；
- 本项目配置 ID；
- 本项目特有的排障规则。

### 2.3 当前项目搜索顺序

当 Agent 在 `hotel-b` 中收到“运行并验证当前项目”的任务时，标准流程必须是：

1. 精确解析当前目录对应的 `hotel-b`；
2. 先检索 `hotel-b` 的本地知识；
3. 再沿 `hotel-b --PART_OF--> activity-platform-a` 检索允许继承的父项目知识；
4. 同稳定键同时存在时，`hotel-b` 本地项覆盖父项目项；
5. `local_only`、未定向授权项和 `RELATED_TO` 不扩张作用域；
6. 当前目录同时匹配多个项目时停止猜测，要求选择精确项目。

父项目知识只有设置为 `descendants`，或通过 `selected_projects` 定向授权给当前子项目时，才能向下复用。

---

## 3. P0 Gate A：Agent 生命周期不依赖自觉

### LIFECYCLE-01：任务入口

Claude Code 安装态必须同时满足：

- Fuli MCP 配置包含 `alwaysLoad: true`；
- `UserPromptSubmit` Hook 调用 `begin_task_context`；
- Hook 输入使用当前 session ID 和当前工作目录；
- `begin_task_context` 返回不透明 `taskContextToken`、匹配项目和有效偏好。

失败条件：

- 只在 Prompt 中要求“记得调用”；
- 模型可以直接回答而完全跳过任务入口；
- Hook 保存或回传机器绝对路径。

### LIFECYCLE-02：任务出口

`Stop` Hook 必须调用 `verify_task_checkpoint`。

若任务已成功开始但尚未检查知识价值，Stop 必须阻止结束，直到 Agent 二选一：

- `capture_candidates`：保存一个小而有依据的候选批次；
- `retain_nothing`：说明本轮没有值得沉淀的内容。

失败条件：

- 强制每轮都写入知识；
- 允许结束但完全没有检查；
- 保存原始对话、临时日志、猜测或凭据。

### LIFECYCLE-03：跨 Agent 状态

- Claude Code：Hook Gate 必须通过；
- 没有等价生命周期 Hook 的 Agent：只能标为 `PROMPT_FALLBACK`，不得宣称达到确定性 Gate；
- 新增 Agent 适配器不得改变 Provider 的通用知识语义。

---

## 4. P0 Gate B：当前项目优先、父项目按需继承

### SCOPE-01：子项目先本地、再父项目

任务：

> 在 `hotel-b` 中运行项目，并说明启动、验证和测试方式。

初始数据：

- `hotel-b`：本项目 PRD、页面约束和合成配置 ID；
- `activity-platform-a`：公共启动、验证和测试 Runbook，`inheritanceMode=descendants`。

必须观察到：

- 工具自动解析 `hotel-b`，调用者不手抄 project ID；
- 检索结果包含子项目局部知识和父项目 Runbook；
- 返回来源项目、`scope_distance` 和 `scope_path`；
- Agent 不因父项目包含更多内容而忽略子项目事实。

### SCOPE-02：父项目本地知识隔离

父项目 `local_only` 项不得进入 `hotel-b`。

### SCOPE-03：定向继承

`selected_projects=[hotel-b]` 的父项目知识只在 `hotel-b` 命中，不在 `flight-c` 命中。

### SCOPE-04：普通关联不扩张

`botany-e --RELATED_TO--> activity-platform-a` 不得获得活动平台或酒店知识。

### SCOPE-05：子项目覆盖父项目

父子存在相同稳定键时，只返回子项目当前有效项；历史和父项仍可审计，但不得同时作为当前规则注入。

### SCOPE-06：路径歧义

从同时包含多个已注册子项目的上级目录运行时，Fuli 必须返回 `ambiguous`，不能任选一个项目。

---

## 5. P0 Gate C：公共知识候选与原子上收

### CONVERGE-01：只读候选发现

在 `hotel-b`、`flight-c`、`travel-d` 中分别保存语义相近的合成重试 Runbook。

调用公共候选发现时必须：

- 只扫描父项目的直接 `PART_OF` 子项目；
- 每个子项目独立检索；
- `inherit_project_knowledge=false`；
- `include_personal_global=false`；
- 返回来源项目、原始项、相似度及推断依据；
- 明确 `requires_human_confirmation=true`；
- 不执行创建、移动、失效或合并。

这里的稳定键、词法重合或向量相似度都只是“值得一起审查”的启发式证据，
不是语义等价证明。即使三个项目都出现 “2 attempts + 140ms jitter”，它们也可能分别用于
房态查询、支付下单和缓存刷新，前置条件、失败副作用和安全边界并不相同。

候选未命中不等于产品失败；报告必须区分“无相似候选”和“检索错误”。

### CONVERGE-02：人工预览

人工选择：

- 父项目；
- 规范项；
- 重复项；
- 公共化理由；
- 人工确认理由。

预览必须校验：

- 所有项来自不同的直接子项目；
- 所有项当前有效且类型一致；
- 推断相似度不能替代人工确认；
- 返回绑定完整意图的短期一次性 `previewToken`。

### CONVERGE-03：原子上收

使用匹配的 `previewToken` 后，Provider 必须在一个事务中：

1. 把规范项归属到父项目；
2. 设置 `inheritanceMode=descendants`；
3. 将选定重复项失效；
4. 将重复项的 replacement 指向规范项；
5. 保存原作用域、当前作用域、公共化理由和人工确认理由；
6. 保留所有原始 Episode 和修订历史。

任一步失败时不得留下部分上收状态。Token 变更、过期或重放必须拒绝。

### CONVERGE-04：局部例外

上收后，子项目仍可用同稳定键保存明确的局部覆盖；搜索必须解释“继承自父项目”或“子项目覆盖父项目”。

---

## 6. 决策、时间与冲突

### TIME-01：知识演化

旧决定和新决定必须同时可审计，默认只返回当前项；历史查询能说明：

- 以前使用什么；
- 现在使用什么；
- 替代关系；
- 替代理由；
- 生效和失效时间。

### DECISION-01：理由是一等数据

一个完整决策轨迹至少包含：

```text
Decision
  ├─ SELECTED_OPTION ─▶ DecisionOption
  ├─ REJECTED_OPTION ─▶ DecisionOption
  ├─ MOTIVATED_BY ────▶ DecisionRationale
  └─ VALIDATED_BY ────▶ ValidationResult
```

必须保存：

- 决策问题；
- 被选方案；
- 被否方案；
- 选择理由；
- 决策者与确认权威；
- 后续验证结果及 `pass / fail / inconclusive`。

失败条件：

- 只保存最终结论；
- 把“人类选择 B”推导成“A 一定错误”；
- 把尚未验证的决定标为已经验证。

### DECISION-02：给既有决策追加验证

初次记录决策时允许没有验证结果。后续压测、上线观察或事故复盘产生证据后，系统应提供
面向既有 `Decision` 的追加入口，例如：

```text
append_decision_validation(
  decisionId,
  status=pass | fail | inconclusive,
  evidence,
  observedAt
)
```

该入口必须创建不可变的 `ValidationResult` 并用 `VALIDATED_BY` 关联原决策；不得要求调用方
重建整条决策轨迹，也不得覆盖原理由。重复提交按决策、证据和观察时间幂等，历史查询能展示
每次验证，当前视图能解释最新验证状态。

### CONFLICT-01：冲突不静默选边

同一偏好键、同等最高权威的冲突项不得自动注入。Agent 只有在当前任务确实需要该偏好时，才可依据证据和当前上下文执行延迟冲突解决，并永久保存理由和解决者。

---

## 7. 正向使用、负面证据与记忆污染

### CONFIDENCE-01：正向使用

- 检索本身不计为使用；
- 只有确实影响回答或行动的 `cited` / `applied` 才计数；
- 同任务、同知识项、同使用类型、同内容代际幂等；
- Agent 使用证据只能晋级为 `agent_confirmed`，不能伪造人工确认。

### FEEDBACK-01：负面证据

支持的负面事件：

- `rejected`
- `validation_failed`
- `contradicted`
- `outdated`

每个事件必须保存：

- item、task、内容代际和事件类型；
- 报告者权威；
- 理由；
- 证据摘要；
- 可选的 HTTP(S) 来源；
- 发生时间。

效果：

- 事件按任务和内容代际幂等；
- 降低效用和置信分；
- 标记 `requires_attention=true`；
- 搜索结果暴露负面证据计数、最近类型和时间；
- 排序降低“需关注”项的优先级；
- Agent 负面证据不能自动取消人工确认；
- 人工/权威来源的反证可以把 `agent_confirmed` 退回 `pending`；
- 内容被修订后开启新代际，旧负面证据保留审计但不继续污染新内容。

### FEEDBACK-02：候选提醒偏好与负向权重

公共化候选被拒绝后不新增独立 cooldown 状态机：

- 一次具体拒绝记录到候选聚类指纹的 `rejected` 负面证据，降低该候选的推荐权重；
- 用户明确表示“不想再收到这类提醒”时，才保存项目范围的候选提醒偏好；
- 负向权重影响排序、频率和触发阈值，不删除候选，也不改变知识真值、确认权威或作用域；
- 单个候选的一次拒绝不得自动升级成个人全局偏好；
- 新证据、内容新代际或人工主动查看时仍可恢复可见性，并解释此前为什么被降权。

### POLLUTION-01：一次性内容

一次出现的偏好或临时选择保持 `pending` / 按需搜索，不自动成为长期偏好。

---

## 8. 协作成本 A/B

### 8.1 配对方法

同一模型、版本、推理强度、任务、代码状态和预算下比较：

- Baseline：没有 Fuli；
- Treatment：有 Fuli。

任务顺序随机化。不得把目标答案或稳定标记直接写进 Treatment Prompt。原始对话不持久化，只记录结构化指标。

### 8.2 指标

- 用户补充上下文的字符数和轮次；
- Agent 澄清轮次；
- 修正轮次；
- 首次回答验收通过率；
- 最终任务通过率；
- 完成时长、输入/输出 token 和成本；
- 相关知识召回率；
- 无关知识泄漏率；
- 已知旧错误复发率；
- 负面证据出现后仍复用错误知识的比例。

### 8.3 本版阈值

这些是 Benchmark v2 的测试约定：

- 冒烟：每场景 5 次，只能报告趋势，不能形成产品结论；
- 产品结论：至少 30 个配对任务；
- Treatment 首次通过率不得下降；
- 用户补充上下文中位数至少下降 20%；
- 修正轮次中位数至少下降 20%；
- 无关知识泄漏和错误复发不得高于 Baseline；
- 安全或权威边界出现一次严重违规，则整体不通过。

---

## 9. 真实 Agent 验证

### AGENT-01：Claude Code

必须验证：

- 安装后的 `alwaysLoad`、入口 Hook 和 Stop Hook；
- 全新非持久化 session 能复用上一 session 沉淀的知识；
- 当前项目搜索无需模型手抄 personal space/project ID；
- Stop Hook 能阻止未完成知识检查的任务；
- `retain_nothing` 不产生知识写入；
- `capture_candidates` 只产生小批次候选。

### AGENT-02：其他 Agent

对 Codex、Cursor、Kiro 等分别报告：

- `HOOK_ENFORCED`
- `PROMPT_FALLBACK`
- `NOT_CONNECTED`

不得把 Prompt fallback 等同于确定性生命周期。

### AGENT-03：长期使用

只有可识别的真实客户端和足够长的任务序列，才能报告：

- 重复解释是否下降；
- 历史命中是否实际被使用；
- 旧错误是否减少；
- 错误知识是否因负面证据降权。

通用 MCP 调用不能替代某一命名 Agent 的长期集成结论。

---

## 10. 最终判定

### PASS

- 三个 P0 Gate 全部通过；
- 项目继承、覆盖、隔离和歧义处理通过；
- 决策理由、历史和负面证据可检索；
- 没有人工权威越权或跨项目泄漏；
- A/B 达到预设阈值。

### PARTIAL

- 核心正确性通过，但真实 Agent、样本量或协作成本证据不足；
- 没有安全越权或数据污染。

### FAIL

- 发生跨项目泄漏、人工权威被 Agent 静默覆盖、部分原子写入、凭据持久化；
- 当前项目不能可靠获取允许继承的父项目 Runbook；
- Fuli 只保存对话，不能可靠复用或降低协作成本。

最终问题仍然是：

> 如果没有 Fuli，Agent 是否必须重新学习已经确认、仍然有效且与当前项目相关的信息？

Fuli 的价值不在“记住更多”，而在“以正确作用域、权威、时间和理由，少重复学一次”。
