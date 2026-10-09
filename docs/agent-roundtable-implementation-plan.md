# Agent Roundtable Product Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Publish an installable Fuli beta supporting persistent, controlled collaboration between independently connected agents on multiple computers, with Grok API and truthful platform capabilities.

**Architecture:** Fuli retains identity and knowledge authority. A JavaScript roundtable domain uses an explicit transactional SQLite collaboration store and participant ports. HTTP/MCP, CLI workers, native client adapters and Vue views consume the same service; no transport implements separate domain behavior.

**Tech Stack:** Node 24 node:sqlite, MCP SDK, plain JavaScript, Vue 3, existing Fuli application ports.

**验证快照：**2026-10-09，CI 对应提交 `471737c`。完成勾选表示该实现或检查已有证据；真实模型、物理多电脑、视觉验收和发布分别记录，不能由自动测试代替。详见[Beta 验证记录](roundtable-beta-validation.md)。后续提交需要重新完成发布前检查。

## Contracts

Service: `createRoundtableService({databasePath, clock})` exposes `create(input, actor)`, `list(input, actor)`, `read(input, actor)`, `invite(input, actor)`, `revoke(input, actor)`, `authenticate(input)`, `join(input, actor)`, `claim(input, actor)`, `submit(input, actor)`, `control(input, actor)`, `addHumanMessage(input, actor)`, `close()`.
Actor is created at the trusted transport boundary: local owner or authenticated exact room/seat participant; actor fields from request bodies are ignored. Participants cannot create rooms, invitations, change limits, impersonate peers, or access other rooms. Invites are random bearer capabilities, hash-only persistence, bounded expiry, revocable; owner-only API issues them once.
Room input: goal, mode discussion/collaboration, optional validated project binding, seats [{id,name,role:moderator|specialist|implementer|reviewer,runtime:mcp|codex|claude-code|pi|grok|a2a}], bounded limits. Absence of project creates a labeled temporary collaboration scope. read returns room, ordered messages, current turn, tasks/outcome, next cursor. Claim returns turnId, attemptId, fence, deadline, scoped context. Submit has roomId, turnId, attemptId, fence, idempotencyKey, body, kind, artifacts and reported verification. Atomic submit appends one final message and advances legal state; expired results never become current. Reported evidence is not human acceptance.

## Tasks

### 1. Research and protocol choices
- [x] 核实官方项目、许可证及 Grok Bot / API 的不同接入契约，来源保存在 `docs/roundtable-research.md`。
- [x] 借鉴阶段、恢复与受限参与边界；官方 A2A SDK 只用于适配器，文档区分已测试的协议与真实外部服务。

### 2. Collaboration domain and persistence
Files: src/roundtables/{store,domain,service}.js; test/roundtable-service.test.js.
- [x] 完成邀请隔离与撤销、顺序领取、重复提交、过期 fence、硬停止和重启恢复的 focused tests。
- [x] 实现 CAS 事务、日志边界、阶段、职责、任务依赖、分歧与产物证据，以及明确标注的临时作用域。
- [x] 运行相关领域套件；对应代码通过 Linux CI。测试夹具与真实模型回执分开报告。

### 3. Application and transports
Files: src/roundtables/{http-router,server,mcp-server,application,tool-contract}.js; src/cli/roundtable-command.js; src/cli.js; src/graphiti/federated-application.js; src/http/api-router.js; src/agent-tools.js; test/roundtable-http.test.js; test/roundtable-mcp.test.js.
- [x] 经 application port 验证 Fuli 项目与 Agent 绑定；独立席位不冒充 Fuli 身份，关联任务保留原任务验证门槛。
- [x] 接入本地所有者界面，以及有确切房间 / 席位 Bearer 授权和正文边界的 HTTP / MCP 参与端；参与端不开放所有者控制工具。
- [x] 提供 `fl roundtable serve` 与 `fl roundtable worker`，工作端领取自己的获授权回合并提交结果。
- [x] 自动化测试验证独立网络客户端的有序交换、重启持久化与越权拒绝；真实 Codex 回合也通过本机网络完成。
- [ ] 在多台物理电脑上验证网络可达性、各客户端凭据、参与回合、重启及撤销；当前真实 CLI 验收的 `physicalComputers=1`。

### 4. Runtime ports and adapters
Files: src/roundtables/{process,participant-registry,worker}.js; src/agents/{codex,claude-code,pi,grok,a2a}/roundtable-participant.js; test/roundtable-runtime.test.js.
- [x] 实现 preflight / dispatch / cancel、无 shell 拼接的参数数组、所拥有进程的取消与回合期限。
- [x] 受控 CLI 使用私有配置，禁用继承的全功能 MCP、插件与 Hook；默认只读，实施写入需房间及工作端双重授权。
- [x] API 凭据由环境变量引用；上下文、用量与取消按真实报告处理，HTTP 错误保留为失败。
- [x] 完成传输错误、超时、取消与协议夹具检查，并与真实凭据运行分别记录。
- [x] 真实本机 Codex 完成讨论、分工、实施、独立审查和汇总，共 7 个回合全部 `completed`；实际产物验证通过，人工验收仍由用户进行。
- [x] Pi 1.1.0 + 本地 qwen3:8b 的真实读取、字面内容写入和越界拒绝，基本工具检查 3/3 通过。
- [x] Pi 严格结果契约、post-format 和阶段说明完成 20 项专项检查及独立代码复审；圆桌回归 87/87。真实工具和模型报告质量分别记录，模型正文仍为试验范围。
- [x] 各运行端共用当前阶段 / 任务的完成标准；实际 HTTP worker 回归验证讨论不冒充实施、阶段消息类型和人工验收边界，失败不自动升级为成功。
- [ ] Pi 与独立 Codex 审查者的完整混合圆桌，按实际模型与上下文配置验收。
- [ ] Claude Code、Grok API 使用有效凭据的完整真实圆桌验收；Grok Bot 的实际远程 MCP 参与；A2A 独立外部服务验收。

### 5. Product UI and map
Files: web/src/features/roundtables/*; web/src/router/index.ts; web/src/layouts/ConsoleLayout.vue; site/index.html; site/style.css; README.md; README.zh-CN.md.
- [x] 完成创建、列表 / 详情、席位邀请与复制、消息、控制、任务、分歧、产物和来源回执表；缺失模型 / 用量保持未知。
- [x] 使用 `GrowthLoading`，加载标签描述实际请求并提供中英文；组件验证刷新失败和草稿保留。
- [x] 官网和中英文 README 提供能力版图，分别标注已提供、Beta 与待支持；区分 Grok API 和需主动配置的 Grok Bot MCP。
- [x] Vue typecheck、相关组件测试与构建通过；`471737c` 的 CI 中 Vue 371 项通过。
- [x] 圆桌页面通过 IAB 实际验收：中英文切换、无项目草案、Codex / Pi 席位、Pi 邀请模型输入与凭据隐藏、停止状态；400 × 850 视口实测 `documentWidth = bodyWidth = 400`，无横向溢出，截图核对席位纵向布局。
- [ ] 官网、其他页面和最终 registry 安装包界面仍待视觉验收。上述页面检查未启动模型、没有执行回执；使用的静态构建早于 Pi 模型 placeholder 更新，不能代替最终构建验收。

### 6. Verify, review and publish
Files: acceptance/roundtable-network.js; docs/roundtable-beta-testing.md; package.json; npm-shrinkwrap.json; release notes.
- [x] `471737c` 的 Linux CI：Node 共 1026 项，1018 通过、0 失败、8 跳过；Vue 371 通过；package smoke、audit 0 漏洞与 Provider 检查通过。
- [x] Windows 完整套件的 29 项失败与所比较基线逐项匹配；记录环境边界，不把本机完整套件称为已全部通过。
- [x] 已进行独立代码审查，core、协议、worker、Codex 隔离和 parser 的多轮问题修复后无 P1 / P2；相关 focused 检查 72/72，后续检查 8/8。
- [x] Pi 新增 post-format 变更完成独立复审，修复环境继承越界、失败升级、分歧丢失和上下文完整性问题；未发现尚未解决的 P1/P2。
- [ ] 对最终发布提交重新执行必要检查。
- [x] 设置 semver 预发布版本；提供 `docs/roundtable-beta-testing.md` 的跨电脑步骤和本页证据范围，保留主工作区用户修改。
- [ ] 发布 GitHub prerelease / npm beta dist-tag，核实 registry 版本与 tarball，并验证官网部署。
