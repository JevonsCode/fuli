# Agent 接入与 MCP 工具

[English](agent-tools.md) · 简体中文 · [README](../README.zh-CN.md)

每个客户端装了哪些 Skills 和 Hook、Claude 网页版的远程上游，以及 MCP 工具清单。

## Agent 接入与主要工具

Fuli 为支持的 Agent 安装 `capturing-session-knowledge`、`grilling-project` 和 `operating-fuli`
Skills。`/flreview` 知识回顾已停用（11-11）：它的四个工具不再列出，本版本内仍调用它们的客户端会收到
`tool_retired`。Fuli setup 为 Claude Code 生成
`UserPromptSubmit`/`Stop` MCP Hook，为 Codex 生成 `UserPromptSubmit` MCP Hook 和本地 `Stop`
命令，为 Cursor 生成 `sessionStart`/`beforeSubmitPrompt`/`stop` Hook。Codex bootstrap 和 Cursor
指令只在未收到生命周期上下文时使用 fallback，不重复已提供的偏好。Codex 的 Stop 命令首次
阻止未完成检查；若一次继续后仍未完成，只对同一 token 写入 `retain_nothing` 防止无限循环，
不生成知识或角色记忆。安装配置不会代替用户批准宿主信任。偏好正文始终以本机 Fuli 为唯一
来源，不复制到 Agent 配置中。`operating-fuli` 要求 Agent 在写数据前先检查结构化接口覆盖目录，
写后用对应读取工具验证；浏览器自动化只用于可选的视觉检查，不作为数据写入手段。详见
[Agent 接口架构](agent-interface-architecture.md)。

FULI MCP 还提供只读的 `fuli://` resources：每个本地个人项目和“全局品味”各有一个可选条目。
支持 MCP mention 的 Agent 可以在 `@` 选择器里选中它们；项目条目只代表一个精确项目，
不会因为选择而自动扩大到其他项目或 `RELATED_TO` 项目。

### Claude 网页版 / Cowork 的远程上游

`fuli remote-mcp` 提供绑定单一个人项目、最小权限的 Streamable HTTP MCP 上游。它把来源
独立记录为 `claude`，要求仅 owner 可读的 bearer token 文件，拒绝跨站 Origin，并且只监听
loopback：

```bash
umask 077
openssl rand -hex 32 > ./fuli-remote.token
fuli remote-mcp --personal-project-id YOUR_PROJECT_ID \
  --bearer-token-file ./fuli-remote.token --port 2728
```

在 POSIX 系统上，CLI 会以 nonblocking + no-follow 方式打开 token，并要求权限为 `0600`。
Windows 无法通过 Node.js 获得同等的 `O_NOFOLLOW` 与 POSIX 权限保证，因此 token 必须放在
受 Windows ACL 保护的目录中，必须是普通文件且不能使用链接。

启动前会校验该项目确实属于当前个人空间；默认最多同时保留 8 个会话，并清理空闲超过
15 分钟的会话；需要时可用 `--max-sessions` 和 `--session-idle-ttl-seconds` 调整。“空闲”按
已完成的 MCP 应用请求计算，静默的独立 SSE 通知流不会永久占用会话槽；到达 TTL 后连接
可能被关闭，客户端须重新连接并初始化新会话。关闭服务时，正在处理的有界请求与会话清理
共享同一个宽限截止时间，超时后才强制关闭剩余 HTTP 连接。若反向代理
会转发浏览器 `Origin` 或保留公网 Host，用
`--allowed-origin https://connector.example --allowed-host connector.example` 显式配置；否则让
代理把 Host 重写为 loopback 上游地址。任意未允许的 Origin 和 Host 都会被拒绝。每个 MCP
会话只能读取任务入口为它选中的 Agent 私有上下文与记忆。checkpoint token 还同时绑定上游
配置的项目和创建它的 MCP 会话，其他项目进程或同项目的其他会话都不能复用。

这只是内部上游，不是公网部署。Claude 自定义连接器从 Anthropic 云端发起请求，因此仍须在
监听器前配置公开 HTTPS 与 OAuth 2.1 代理；代理必须校验用户身份、token audience 和最小
scope，再把外部 token 换成内部 bearer，绝不能开放 Fuli Provider 或 Neo4j 端口。
claude.ai 不运行本机生命周期 hooks；MCP 初始化指令会要求每项任务先恢复角色、结束前
checkpoint，但只有真实连接后的 Claude 会话才能证明该行为。

当任务需要品味或判断建议时，`get_user_taste_skill` 会根据当前生效的个人档案和历史任务
数据生成一份有界、只读的 `user-taste` Skill 结论。它会标注证据状态与作用域，返回与当前
任务匹配的推荐，并在偏好新增或修订后重新生成；不会覆盖用户自己编写的 taste Skill，持久
图谱仍是唯一来源。

| 工具 | 用途 |
| --- | --- |
| `begin_task_context` | Hook 入口：解析任务、在命中信号时执行有界召回并创建任务令牌 |
| `get_collaboration_preferences` | Fallback 入口：读取生效偏好和有界任务召回 |
| `get_user_taste_skill` | 生成当前带证据状态的 taste Skill 结论和任务推荐 |
| `search_current_project_knowledge` | 子项目优先、按授权关系向上检索 |
| `search_knowledge_graph` | 在明确的有界范围内执行更通用的查询 |
| `search_connected_knowledge` | 分开检索图谱、项目绑定的只读来源和选定公共项目，保留来源边界 |
| `record_knowledge_usage` | 记录真正影响结果的引用或应用 |
| `record_knowledge_feedback` | 保存拒绝、验证失败、冲突或过时证据 |
| `record_decision_trace` | 保存选择、被拒方案、理由和可选初始验证 |
| `capture_session_knowledge` | 批量写入少量、结构化的候选知识 |
| `checkpoint_task_knowledge` | 以 `capture_candidates` 或 `retain_nothing` 结束知识检查 |
| `discover_common_knowledge_candidates` | 只读发现可能属于上级项目的公共候选 |
| `preview_common_knowledge_promotion` | 预览人类确认的公共知识提升 |
| `apply_common_knowledge_promotion` | 使用一次性令牌原子执行提升 |
| `resolve_deferred_preference_conflict` | 在实际需要时处理已授权给 AI 的冲突 |
