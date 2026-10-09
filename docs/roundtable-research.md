# Agent 圆桌接入与开源研究

核实日期：2026-10-09。本文是官方文档、仓库与公开 npm 元数据的研究记录，
不是接入验收报告；没有启动模型、读取密钥或更改运行配置。

## 建议

采用 Fuli 自有圆桌领域与协调任务，运行时通过统一 participant port 接入。
完整 beta 应同时提供真实本机 CLI、开放 MCP 参与、远端 A2A、API 模型席位，
并展示每个入口的实际就绪、执行、取消和证据状态。已有身份、授权、记忆、
任务验证、租约和时序历史继续由 Fuli 管理。

最适合直接增加的依赖是官方 `@a2a-js/sdk`。群聊、恢复和工具授权借鉴下表的
设计；不引入另一套框架来接管 Fuli 的记忆和任务真相。此项是结合本项目架构
作出的工程判断。

## 开源方案与取舍

| 方案 / 官方来源 | 当前能力与许可证 | Fuli 应采用什么 | 集成代价与边界 |
| --- | --- | --- | --- |
| [A2A JavaScript SDK](https://github.com/a2aproject/a2a-js) | Apache-2.0；A2A v1.0，JSON-RPC、REST、gRPC；v0.3 兼容需显式开启 | **直接集成客户端适配器**：Agent Card、任务、流、产物、取消；必要时以相同领域操作托管服务端 | Node >=20；JSON-RPC/REST 客户端不需要 Express、gRPC 或 SQL 数据库。协议不会替用户登录或操纵封闭客户端 |
| [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)、[A2A 接入](https://github.com/microsoft/agent-framework/blob/main/python/packages/a2a/README.md)、[许可证](https://github.com/microsoft/agent-framework/blob/main/LICENSE) | MIT；Python/.NET；开放模型提供方、工作流、MCP 与远端 A2A 包装 | 借鉴远端 Agent 能力包装；把外部 MAF 服务作为 A2A 席位 | 整体引入会增加 Python/.NET 编排与生命周期；本项目 JS 应用层已有相关职责。核实具体 A2A 包版本，不能从框架总版本推断兼容性 |
| [LangGraphJS](https://github.com/langchain-ai/langgraphjs)、[interrupt](https://docs.langchain.com/oss/javascript/langgraph/interrupts) | MIT；有状态图、持久检查点、暂停和恢复；可不依赖 LangChain | 借鉴可验证阶段转换、等待用户和恢复设计；复杂新工作流可另行使用 | Fuli 现有任务和圆桌存储已具状态权威，引入会新增检查点同步责任。恢复节点会重跑 interrupt 前代码，副作用仍必须幂等 |
| [AutoGen](https://github.com/microsoft/autogen) | 代码 MIT；文档存在 CC-BY-4.0；Python AgentChat/Core，群聊、分布式运行时 | 借鉴轮流/点名发言和组合终止条件 | 官方仓库已标明维护模式，不新增功能，推荐新项目用 Agent Framework；因此不选作新产品底座 |
| [CrewAI](https://github.com/crewAIInc/crewAI)、[A2A](https://docs.crewai.com/en/learn/a2a-agent-delegation) | MIT；Python 角色任务、流程；`crewai[a2a]` 可代理远端 Agent，也可托管 A2A Agent | 借鉴单一任务负责人、预期产物和阶段交接；远端 CrewAI 服务通过 A2A 接入 | 应用内多模型协作与用户已有客户端互通是不同验收目标；整体引入增添 Python 运行时、记忆与工具策略 |
| [OpenClaw](https://github.com/openclaw/openclaw)、[CLI backends](https://docs.openclaw.ai/gateway/cli-backends)、[remote node](https://github.com/openclaw/openclaw/blob/main/docs/cli/node.md) | MIT，另有第三方 notices；Gateway、可更换模型/harness、消息渠道和远端节点 | **重点借鉴运行时边界**：CLI JSONL、私有 MCP 配置、当前尝试有效的接入 grant；外部 OpenClaw 可成为受限席位 | 自身是完整常驻 Gateway；不需要把它捆进 Fuli。远端节点执行命令需配对授权，不等同跨厂商既有聊天 API |
| [OpenBot](https://github.com/CopilotKit/OpenBot)、[配置](https://github.com/CopilotKit/OpenBot/blob/main/docs/configuration.md)、[许可证](https://github.com/CopilotKit/OpenBot/blob/main/LICENSE) | MIT 的早期模板；每位 coworker 独立电脑，AG-UI 远端 Agent、授权与记录 | 借鉴明确授权、电脑/文件边界和显示真实活动；AG-UI 可作为独立未来 UI 适配方向 | 私有 workspaces，没有可依赖发布包；需 Docker、Bun、Postgres 和 CopilotKit Intelligence 项目。Intelligence 依赖及 entitlement 不因模板 MIT 自动消失 |
| [Google ADK JS](https://github.com/google/adk-js) | Apache-2.0；Node >=20.19；顺序/并行/循环 Agent、MCP、A2A | 外部 ADK Agent 可直接走 A2A；借鉴清晰工具 schema | 与现有 Fuli 编排重复；不需要为接入一个远端 Agent 把整个 ADK 引入 |
| [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) | Apache-2.0；编辑器与 coding Agent 间的会话、权限与更新协议；v1 稳定，v2 明确是草案 | 支持 ACP 的 coding Agent 可加独立 participant adapter | ACP 解决客户端控制 coding Agent 的问题；A2A 解决独立 Agent 的远端任务契约。应各自报告实际协商能力，不把实验 v2 当已稳定支持 |

许可证记录描述上述仓库本身；引入代码须保留相应 LICENSE/NOTICE，模型服务、
托管平台与可选组件仍按各自条款。当前决定仅直接引入官方 A2A SDK，其他条目
作为设计来源或外部端点，不复制框架代码。

## A2A 适配具体决定

公开 npm `latest` 元数据于本次读取为 `@a2a-js/sdk@1.3.0`；唯一必需 runtime
依赖为 `jose`，Express、gRPC、Kysely 与数据库驱动都是 optional peers。
见[官方 package.json](https://github.com/a2aproject/a2a-js/blob/main/package.json)。
实现应锁定并测试实际安装版本，避免使用旧 0.3 SDK 示例来构建 1.x 接口。

采用 `ClientFactory` 配合 `JsonRpcTransportFactory` / `RestTransportFactory`，
通过 Agent Card 选择支持的接口。`sendMessage` / `sendMessageStream` / `getTask`
与 `cancelTask` 支持每次请求的 signal 和 serviceParameters headers。
SDK 提供认证重试辅助器；Fuli 不自动采用其 401/403 重试行为，因为认证失败
需要明确转入 waiting_auth。上述契约见[官方 SDK 文档](https://github.com/a2aproject/a2a-js)。

建议映射：describe 保存真实 Agent Card 能力；preflight 做发现/认证和版本检查；
dispatch 保存远端真实 task/context ID；observe 转换 task/status/artifact 事件；
cancel 请求远端取消，只有收到对应终态才显示确认停止。AbortSignal 中止本地
网络等待不证明远端工作停止。room/seat/turn/attempt/fence 与远端 ID 的关联由
Fuli 持久化；远端 completed 只能完成该回合，不能越过 Fuli 协调任务验证。

不要默认启用 push webhook 或另外增加 SDK SQL task store；当前 Provider 已有
存储权威。若后续托管 Fuli A2A 服务端，应通过注入 store 与领域端口接入既有
存储，避免第二份任务完成状态。端点与鉴权只从明确配置读取，不自动发现私人
端点或从 Agent Card 声明扩大权限。

## Grok Bot、Grok API 与第三方 grokbot

**Grok Bot 是真实的官方产品。** 官方[概览](https://docs.x.ai/grok-bot/overview)
描述长期保留的 AI 同事与云电脑。[协作文档](https://docs.x.ai/grok-bot/chat-and-collaboration)
明确支持 2–6 位 Bot 群聊、点名、异步交接和接收 Bot 唤醒。[FAQ](https://docs.x.ai/grok-bot/faq)
同时说明：同一账户的 Bots 共用一台持久云电脑、文件、浏览器会话和登录，不能
把不同 Bot 当安全隔离边界；关闭笔记本后后台工作仍可继续。

官方[Team Bots 插件表](https://docs.x.ai/grok-bot/team-bots)明确列出 Custom MCP
server 的 Remote HTTPS 与 Command 两种方式；HTTPS 可使用 Bot 自身凭据或
按用户 OAuth，Command 在会话使用的云电脑运行。这证明 Grok Bot 可以配置
Fuli 的远程有限圆桌 MCP 工具，主动读取/接受/提交自己的席位回合。

本次查阅的 Bot 文档没有提供外部系统向现有 Bot 发消息或启动其后台回合的
公开编程契约；内部 Bot-to-Bot 唤醒不能推导为 Fuli 拥有相同外部控制能力。
因此 native Grok Bot 接入以实际 MCP 会话参与为证据，不把配置可用或 API
模型输出展示为“原生 Grok Bot 已自动参与”。这是一项当前文档边界，后续发现
正式 Bot API 时可增加独立适配器。

GitHub 的 [xlviitheroman/grokbot](https://github.com/xlviitheroman/grokbot)是
第三方 Discord Bot，README 使用 `DISCORD_TOKEN` 和 `GROK_API_KEY`，与官方
Grok Bot 产品不同；不选其作为跨 Agent 编排或官方 Bot 接入依据。

## 自动 Grok API 席位

xAI API 与用户已有 Grok Bot 是两个入口。自动 API 席位应显示提供方、实际
model、真实请求 ID、usage 与结果，来源明确写为 Grok API。

[Quickstart](https://docs.x.ai/developers/quickstart)与
[Remote MCP](https://docs.x.ai/developers/tools/remote-mcp)使用 `XAI_API_KEY`、
`https://api.x.ai/v1` 和 Bearer authentication。官方当前示例为 `grok-4.7`；
应允许配置并通过[模型目录](https://docs.x.ai/developers/models)预检，不能
把旧模型名称视为永久可用。新版适配优先 `/responses`；
[Chat Completions](https://docs.x.ai/developers/model-capabilities/legacy/chat-completions)
官方已标注 legacy，新功能先进入 Responses。

[Function Calling](https://docs.x.ai/developers/tools/function-calling)支持自定义
JSON Schema function tools、auto/required/none/指定工具选择，默认允许一次多
工具调用，可用 `parallel_tool_calls: false` 禁止。由 Fuli 管理的本地 tool loop
只执行 seat allowlist，校验参数与授权，回传每个 call ID 的结果，并硬限制调用
次数与时间。模型提出工具调用不是已执行证据。

[Remote MCP](https://docs.x.ai/developers/tools/remote-mcp)支持 xAI native SDK 和
OpenAI-compatible Responses；服务器连接由 xAI 执行，仅 Streaming HTTP/SSE，
支持 authorization/headers 和 allowed_tools。空或缺失 allowlist 会开放全部
服务器工具；`require_approval` 和 `connector_id` 当前不支持。Fuli 因此需要
自己执行授权和有限工具服务，不能把 API 不支持的 approval 字段当安全门槛。
只有从 xAI 可达的明确授权 HTTPS 端点才能用此路径；本机 loopback/stdio 可
通过 Fuli 自己的本地 tool loop 处理，不应宣称云端能访问本机。

凭据配置只存环境变量名或既有 secret reference；不在房间、日志、状态响应、
提示词或研究记录中保存值。HTTP 401/403 转为等待授权，400/422 参数错误和
404 模型/端点错误不盲目重试。429 与可恢复传输故障可在本次预算内至多一次
退避重试；执行副作用后状态不明时先 observe，不能重新 dispatch 制造重复。
错误语义见[xAI Debugging](https://docs.x.ai/developers/debugging)；重试次数是
本项目设计策略，不是 xAI 默认承诺。

## Beta 验收证据

- 独立本机 CLI 要证明真实提案、审查、修订及任务产物；真实凭据不足记为阻塞。
- native MCP 席位要证明独立认证会话的跨席位消息和回合流；可复制配置不算已连接。
- A2A 要用独立服务证明 discovery、task 生命周期、流/轮询、input/auth 等待、
  artifacts、取消确认与过期结果隔离；本地 fixture 明确标为协议测试。
- Grok API 真实调用需要报告真实 model/ID/usage；无 API 凭据仅验证 parser、
  错误映射和协议，不能报告已真实模型验收。
- Grok Bot 插件配置及主动圆桌回合必须用其真实客户端证明；未经验证的外部
  自动唤醒、封闭聊天移交、全天托管和跨组织隔离均不能成为发布承诺。

这些证据级别可同时存在。完整 beta 是包含接入、授权、状态、恢复、停止与
交付的产品；协议或模拟测试不能代替相应真实运行验证。
