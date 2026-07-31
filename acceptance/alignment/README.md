# Fuli × Claude Code 自循环对齐验收

本目录提供一次性的黑盒验收环境，用真实 Claude Code、真实 Fuli MCP、真实
Graphiti/Neo4j 验证知识沉淀、搜索、项目继承和公共知识收敛。

## 数据披露

`fixtures/` 下的项目、规则、决策、时间、编号和对话片段全部是**合成验收数据**，
不是生产事实，也不来自真实用户。文档中的稳定标记只用于自动判分，不是凭据。

公开数据集只用于设计题型：

- [LoCoMo](https://github.com/snap-research/locomo)：长对话、多会话时间线和跨会话问答；
- [LongMemEval](https://github.com/xiaowu0162/longmemeval)：信息抽取、多会话推理、知识更新、
  时间推理和拒答；
- [SWE-bench](https://www.swebench.com/)：由问题描述、仓库证据和补丁结果组成的软件任务；
- [LMSYS-Chat-1M](https://huggingface.co/datasets/lmsys/lmsys-chat-1m)：只参考真实对话的题型分布，
  不下载或复制其中的原始会话。

## 隔离边界

- 使用独立的 Docker Compose 项目、独立 Neo4j 数据卷和运行时随机凭据；
- Claude Code 通过 `--strict-mcp-config` 只连接本次临时 Fuli MCP；
- 使用生产 Claude Code 连接器生成 `alwaysLoad`、`UserPromptSubmit` 入口 Hook 和
  `Stop` checkpoint Hook；
- Agent 结束前必须执行 `capture_candidates` 或 `retain_nothing`，后者不会强制写入；
- Claude 的写权限限制为 Fuli 工具，测试项目是临时副本；
- 不读取或写入现有个人 Fuli 图谱；
- 不保存原始 Claude 对话、运行时配置或凭据；
- 无论通过、失败还是中断，运行器都会尝试删除容器和数据卷。

在资源繁忙的本地 Docker 环境中，Graphiti 首次建立隔离索引可能需要数分钟；运行器
允许最多 8 分钟的 Provider 冷启动，但不会复用或停止用户现有的 Fuli 容器。

## 运行

```sh
node acceptance/alignment/run.js
```

默认使用 Claude Code 的 `sonnet` 模型、中等推理强度和单次调用预算上限。可用环境变量调整：

```sh
FULI_ALIGNMENT_CLAUDE_MODEL=sonnet \
FULI_ALIGNMENT_CLAUDE_EFFORT=medium \
FULI_ALIGNMENT_CLAUDE_BUDGET_USD=0.40 \
node acceptance/alignment/run.js
```

只运行确定性的 Provider/MCP 验收：

```sh
node acceptance/alignment/run.js --skip-claude
```

当本机 Docker 不可用时，可单独验证真实 Claude Code 的入口 Hook、知识检索、
checkpoint 与 Stop Hook 协议：

```sh
node acceptance/alignment/claude-hook-smoke.js
```

该烟测使用生产 MCP 服务器装配代码和完全合成的内存数据，但不经过
Graphiti/Neo4j，因此只能证明 Claude Code Hook 协议链路，不能替代完整 Benchmark。

输出：

- `FULI_CLAUDE_CODE_ALIGNMENT_REPORT.md`：面向人的结论；
- `acceptance/alignment/results/latest.json`：经过脱敏的结构化用例结果。
- `acceptance/alignment/results/hook-smoke-latest.json`：轻量 Hook 烟测的标签级结果。

## 关键判定

项目关系方向为 `hotel-b|flight-c|travel-d --PART_OF--> platform-a`。

- **当前项目优先**：B 先使用自己的 PRD、配置和局部规则，再沿 `PART_OF` 读取 A 的共享 Runbook。
- **向下继承**：B/C/D 只应获得 A 中显式标记为 `descendants` 或定向授权的知识。
- **禁止扩张**：`local_only`、`RELATED_TO` 和无关项目不得进入子项目上下文。
- **本地覆盖**：B 的同稳定键规则优先于 A 的继承规则。
- **候选发现**：B/C/D 的相似内容只生成只读候选，不自动把相似度当作公共性结论。
- **人工预览**：规范项、重复项、作用域理由和人工确认理由必须绑定同一预览。
- **原子上收**：确认后在一个 Provider 事务中完成归属、继承、失效、替代和修订审计。
- **决策理由**：选择、未选方案、理由和验证结果形成可检索链。
- **负面证据**：失败、反驳、过期和拒绝会降权并标记需关注，但不越过人工确认权威。

Benchmark v2 的 5 次行为重复只属于冒烟层；至少 30 个配对任务才允许形成协作成本产品结论。
