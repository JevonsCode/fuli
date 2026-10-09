# Agent 圆桌 Beta 验证记录

核验日期：2026-10-09。本页记录已有证据及其范围，发布前仍需核对最终提交。
圆桌已提供讨论、分工、实施、审查和人工验收的流程；Codex 的完整真实运行停在等待用户验收，未代用户接受交付。Pi 混合圆桌的失败记录另列，未计为完成。

## CI 与发布前检查

已核验的提交为 [`471737c`](https://github.com/JevonsCode/fuli/commit/471737c00e984833dcf3d801781527a8efdbaea9)，
[对应 CI](https://github.com/JevonsCode/fuli/actions/runs/37909776638) 已成功结束。
这些数字属于该提交，后续修改需要重新验证。

| 检查 | 结果 | 证据范围 |
| --- | --- | --- |
| Node 完整套件 | 1026 项：1018 通过，0 失败，8 跳过 | Linux CI；跳过项没有计为通过 |
| Vue 套件 | 371 通过 | 组件、状态和交互检查 |
| Vue typecheck / 构建 | 通过 | 类型及生产资源构建 |
| Package smoke | 通过 | `npm run test:package` 检查打包产物 |
| 依赖 audit | 0 漏洞 | CI audit 和本地最终 audit 记录 |
| Provider 检查 | 通过 | Python Provider 测试及 Compose 配置检查 |
| 独立代码审查 | 多轮修复后无 P1 / P2 | core、协议、worker、Codex 隔离和 parser；focused 检查 72/72，后续检查 8/8 |

Windows 本机完整套件仍有 29 项失败，失败集合与所比较基线逐项匹配。
Linux CI 已通过；Windows 完整套件尚未全部通过，环境差异继续保留为验证范围。

Pi 的新增 post-format 路径与共享阶段提示修复已完成独立复审：圆桌回归 87/87、Pi 专项检查 20/20 通过，未发现尚未解决的 P1/P2。真实 Pi grep 工具验证了配置继承导致的越界及其修复；失败状态、产物引用、分歧、取消和上下文预算分别核对。模型正文可靠性仍为试验范围，最终源码的后续 CI 仍待核验。当前 CI、审查和真实 CLI 证据不自动覆盖后续提交，
GitHub prerelease、npm beta dist-tag、registry / tarball 和官网部署也需分别确认。

## 真实本机 Codex 圆桌

本地回执 `output-roundtable-cli-live-verified.json` 的核验时间为 `2026-10-09T09:20:13.155Z`，
证据级别为 `real_cli_local_network`。三个独立席位通过本机网络完成以下 7 个执行回合：

| 顺序 | 阶段 | 席位 | 回合状态 |
| --- | --- | --- | --- |
| 1 | discussion | 主持人 | completed |
| 2 | discussion | 实施者 | completed |
| 3 | discussion | 审查者 | completed |
| 4 | planning | 主持人 | completed |
| 5 | implementation | 实施者 | completed |
| 6 | review | 独立审查者 | completed |
| 7 | synthesis | 主持人 | completed |

实施者创建 `roundtable-evidence.txt`，独立审查者实际读取并逐字节比较，报告 `passed: true`。
验收程序也确认文件存在、内容完全匹配：

| 产物检查 | 观察值 |
| --- | --- |
| 文件大小 | 52 字节 |
| SHA-256 | `3de9091873b8023d1fbd83bccd8713cf9a44cfa051f6136f9b8dcd2413b39a1e` |
| 回合完成 | 7/7 |
| 独立真实会话 | 7 |
| 报告用量的回合 | 7 |
| 实际模型 | 未知；回执中的 `model` 均为空，未用配置值补齐 |
| 物理电脑 | `physicalComputers=1` |
| 最终阶段 / 状态 | `synthesis` / `waiting_input` |
| 等待原因 | `owner_completion_required` |
| 人工验收 | `not_performed` |

回执将应用标为参与端报告的 Codex，保留 `provenance=participant_reported` 和
`identityVerified=false`。会话、用量及文件结果有真实运行证据，服务端没有独立认证原生进程身份。
已注册席位、预检和讨论计划都不单独算执行；这里的实施与审查依据实际回合、工具行为和产物检查。

这次验证覆盖一台电脑上的独立席位与会话，尚未证明多台物理电脑或不同厂商客户端的完整协作。
独立 reviewer 的通过结论保留为验证报告，用户的人工验收仍待进行。

## Pi 与本地模型

Pi 1.1.0 配合本地 qwen3:8b 已完成 3 项基本真实工具检查。
`output-pi-basic-live.log` 的汇总为 `passed: true`，本地预检通过，实际调用和会话使用 Pi / Ollama；
运行回执中的本地模型别名为 `fuli-roundtable-qwen3:latest`。

| 基本检查 | 结果 |
| --- | --- |
| 读取已存在文件 | 通过；实际调用 read 并返回文件内容 |
| 写入指定字面内容 | 通过；实际调用 write，产物检查通过 |
| 拒绝工作区外路径 | 通过；越界 write 的工具结果为错误 |

上述 3/3 只证明基本读写与路径边界。新增的严格结果整理、执行预算和阶段提示等 Pi 专项检查 20/20 通过，并完成独立复审，
但真实模型报告仍不稳定：Qwen3 的最新检查为 3/4，已有 Qwen2.5:14b 的一次对照为 2/4。
Qwen3 曾有两次 4/4；最后一次读取工具实际返回随机标记，主模型及整理模型的正文却复述错误示例，
该检查如实记为失败，`verification.passed` 保持 false。正确写入及回读、只读和越界拒写有真实工具证据。
Pi 的正文与产物必须由独立审查者检查，不能把一次成功或合法 JSON 当可靠交付。

混合圆桌的首次运行因 Codex 云端 `workspace routing discovery failed` 停在首轮；Pi 仅预检和加入。
短时 Codex ACK 恢复通过后，第二次运行完成 Codex 主持首轮；Pi 在模型调用前因完整请求超出 16K
上下文预算中止，实际用量为 0。两次均没有实施文件、独立审查或汇总，也没有人工验收。
随后新建共享原权重的 `fuli-roundtable-qwen3-32k:latest`，原模型上限实测为 40960，适配器预检及
Ollama 运行状态均确认 32768；一次真实只读探测的工具内容和正文均匹配随机标记，无写入。
所有这些实测都在一台物理电脑上进行。Pi + Ollama 仍为 **experimental（试验接入）**，基本工具或合法输出不能代替完整混合圆桌验收。

### 32K 混合圆桌：真实输出，尚未完成交付

第三次运行记录为 `output-roundtable-mixed-32k.json`，核验时间 `2026-10-09T10:20:51.281Z`。Codex 主持人的讨论回合 `completed`，Pi 使用 `fuli-roundtable-qwen3-32k:latest` 真实生成输出，并报告用量；但 Pi 错把未来 implementation / review 阶段的 `pending` 任务当作当前 discussion 的阻塞，提交 `blocked`。服务最终为 `discussion` / `waiting_input`，原因 `participant_blocked`。`artifactMatches`、`reviewPassed`、`reachedSynthesis` 均为 false，没有完成实施产物、独立审查或汇总，人工验收未进行。

共享阶段提示修复后的运行记录为 `output-roundtable-mixed-phase-fixed.json`，核验时间 `2026-10-09T10:33:57.477Z`。Codex 讨论回合再次 `completed`；Pi 32K CLI 退出码为 0，出现 `agent_settled`，真实生成 input 2391 / output 108 tokens，但回合结果为 `response_invalid`。服务停在 `discussion` / `waiting_input`，原因 `participant_failed`；没有实际产物校验值、审查或汇总完成证据，人工验收仍未进行。`physicalComputers=1`；取消请求、worker 收尾、协调端关闭及所拥有工作区清理均有完成记录。

这两次记录证明模型实际运行过，也证明流程仍未通过；CLI 成功退出不等于结果契约有效或协作完成。共享阶段提示已有修复和专项测试证据，Pi 的有效结果与完整混合流程仍需新的真实验证。

## 其他接入与界面边界

| 范围 | 当前证据 | 仍需验证 |
| --- | --- | --- |
| Grok API | 按官方 API 契约完成协议 fixture 检查 | 缺少有效凭据的真实模型调用、真实 model / usage 与完整圆桌 |
| Grok Bot / Team Bot | 官方支持自定义 Remote HTTPS MCP；已提供有限圆桌 MCP 接入步骤 | Bot 的真实登录、配置、主动加入和领取 / 提交回合；尚未 live 验收 |
| A2A | 官方 SDK 的协议测试 | 独立外部真实服务的发现、任务、产物及取消确认 |
| Claude Code | 适配器与协议 / 故障检查 | 有效凭据下的完整真实运行及跨平台协作 |
| 多台物理电脑 | 本机独立网络客户端、HTTP / MCP、SQLite 恢复和授权检查 | 用户在多台电脑上验证可达性、客户端运行、撤销和恢复 |
| 圆桌页面 | Vue、组件、HTTP 路由、构建检查，以及 IAB 实际页面和 400px 小屏验收（范围见下文） | 其他页面与最终 registry 安装包界面；本次页面验收没有启动模型或取得执行回执 |
| 官网 | 构建与内容检查 | 实际视觉和小屏验收 |

### 实际页面验收

IAB 已实际打开圆桌页面，完成中英文切换，并通过界面创建无项目草案。中文显示“讨论·独立临时任务”，Codex 与 Pi 分别显示为独立席位。Pi 邀请界面可见模型输入，凭据保持隐藏；执行停止操作后，页面显示“已停止”。

在 400 × 850 视口中，实测 `documentWidth = bodyWidth = 400`，没有横向溢出；截图核对了席位的纵向布局。这次验收覆盖上述圆桌页面操作，尚未覆盖官网、其他页面和最终 registry 安装包界面。

页面验收没有启动模型，也没有执行回执，不能作为模型运行或任务完成的证据。验收使用的静态构建早于 Pi 模型 placeholder 从 `gpt-oss:20b` 改为 `qwen3:8b`；该源代码更新另有 focused 组件测试 10 / 10 通过的证据，最终构建仍需复核。

Grok API 席位与现有 Grok Bot 分别验收。官方 MCP 配置能力证明有接入方式，
不证明 Bot 已连接，也不提供由外部 API 唤醒现有 Bot 聊天的证据。
A2A 协议测试不代表完整规范兼容或外部服务已经接通。

后续实际步骤见[跨电脑 Beta 测试](roundtable-beta-testing.md)。测试时分别记录物理电脑、
运行端、实际会话、模型与用量、产物及审查结果；缺少的数据保持未知。
本页只公布必要摘要、相对产物名与校验值，不公开凭据、本机绝对路径或原始运行日志。
