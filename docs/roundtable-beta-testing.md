# Agent 圆桌 Beta：跨电脑测试

Beta 是独立发布通道。它不会自动升级你的稳定版 Fuli、修改其他 Agent 的全局配置，或复制长期知识到公共房间。

## 安装与协调端

要求 Node.js >=24.12。

```powershell
npm install -g fuli-context@beta
fl --version
fl roundtable serve --port 3738
```

打开 `http://127.0.0.1:3738/roundtables`。创建目标，选择讨论或协作任务，设置席位及上限。没有 Fuli 项目时创建独立临时任务作用域；关联既有 Fuli 项目必须使用准确的项目 ID，并通过现有 Provider 验证。

每个席位生成独立邀请，秘密仅显示一次。不要把邀请保存到公开仓库、长期知识或发言中。席位加入后开始圆桌。房间、消息、尝试、任务、结果保存在用户数据目录的 `roundtables.sqlite`；停止服务不会删除记录。中断的尝试等待用户恢复，不静默重做可能已有副作用的工作。

## 其他电脑上的 Agent

协调端需要一个你控制的 HTTPS 地址。可使用已有反向代理或 Tailscale HTTPS 服务；只公开 `/roundtable-peer/`，保持控制台在本机。配置 `--public-url` 让协调端接受准确的代理 Host：

```powershell
fl roundtable serve --port 3738 --public-url https://roundtable.example
```

参与电脑分别使用自己的邀请和已登录的客户端：

```powershell
$env:FULI_ROUNDTABLE_TOKEN = '从本机控制台复制的席位邀请'
fl roundtable worker --url https://roundtable.example --room ROOM_ID --runtime codex --workspace C:\work\project
# 另一电脑用另一邀请：
fl roundtable worker --url https://roundtable.example --room ROOM_ID --runtime claude-code --workspace C:\work\project
```

默认只读。实现席位必须同时在房间里获得明确工作区写权限，并在参与端启动时带 `--allow-write`；只有实施阶段才启用写入。审查席位只读。远端工作区路径按参与电脑填写；协调端不会把自己的文件路径当作另一电脑上的项目。

## Pi + 本机 Ollama

安装当前官方 Pi（>=1.1.0），检查 Ollama 已安装的模型，选择支持工具调用的模型：

```powershell
npm install -g @earendil-works/pi-coding-agent@1.1.0
ollama pull qwen3:8b
@'
FROM qwen3:8b
PARAMETER num_ctx 32768
PARAMETER temperature 0
'@ | Set-Content -LiteralPath .\roundtable.Modelfile -Encoding utf8
ollama create fuli-roundtable-qwen3-32k -f .\roundtable.Modelfile
fl roundtable worker --url https://roundtable.example --room ROOM_ID --runtime pi --model fuli-roundtable-qwen3-32k:latest --workspace C:\work\project
```

这是本次真实测试使用的模型配置。约需下载 5.2 GB；别名共享原模型权重，只为该模型设置 32K 上下文，不修改 Ollama 的全局设置。基本工具测试使用过 16K；完整圆桌的 16K 请求实测超出预算，因此指南推荐 32K。适配器的最低预检要求为 16K；未配置 `num_ctx` 的默认 4K、8K 或更小窗口会明确返回 `model_context_insufficient`。预检通过不代表任意大小的回合都能容纳，完整请求仍会检查预算。也可以选择自己的已安装工具模型；模型名称和实际上下文由预检读取。

Pi 使用工作端本机 `http://127.0.0.1:11434` 的 Ollama；可用 `FULI_PI_BASE_URL` 指定另一个回环端口的 `/v1` 地址。每次调用自动创建并清理隔离的 Pi 配置，不改你的 `~/.pi/agent`。禁用 shell、继承扩展与 MCP，读/编辑/写工具检查准确工作区及 symlink/junction。这里是工具约束，不是操作系统沙盒。允许写入仍需要双重授权。

当 Pi 已执行完工具、最终报告仍不满足圆桌结果契约时，适配器至多调用一次同一本机 Ollama 来整理结果。整理阶段没有工具，产物引用必须对应实际文件证据；明确失败、阻塞或缺少检查证据不能升级为通过。执行和整理共用回合期限，用量分阶段记录，不推算未知的输入或缓存用量。完整证据超出预算时会明确拒绝运行。

当前 Pi / Ollama 为试验接入。Qwen3 的最新严格检查为 3/4，已有 Qwen2.5:14b 对照为 2/4；曾完成 4/4 的运行不代表稳定性。已实际执行读写和路径拒绝，但模型正文可能与真实工具内容不一致，必须由独立审查者检查文件。详细结果见[验证记录](roundtable-beta-validation.md)。

模型安装、工具执行与正确完成任务是不同的验证。模型可能输出错误产物或自报成功，必须由审查者读取实际产物。模型标称上下文也不等于 Ollama 当前加载上下文，可用 `ollama ps` 检查。

Codex 工作端会读取有效 MCP 配置、逐个禁用并再次验证，无法证明隔离时不执行；同时禁用插件、Apps、Hook、通知和继承的额外写入根。保持现有凭据与模型提供商，不改全局配置。可以用 `FULI_CODEX_REASONING_EFFORT=low` 为本次工作端选择受支持的推理强度，不改变其他会话。

## Grok Bot 原生参与

Grok Bot / Team Bot 官方支持自定义 Remote HTTPS MCP。添加如下 MCP URL，并把席位邀请配置为 Authorization Bearer 凭据：

```text
https://roundtable.example/roundtable-peer/v1/rooms/ROOM_ID/mcp
```

仅开放 `read_roundtable`、`join_roundtable`、`claim_roundtable_turn`、`submit_roundtable_turn`。让 Bot 加入、读取议题、领取自己的回合并提交结果。读取其他房间、创建邀请或控制本机均不授权。此接入不代表 Fuli 能从外部 API 唤醒既有 Grok Bot；需要 Bot 主动调用 MCP。官方配置见 https://docs.x.ai/grok-bot/team-bots。

## 自动 Grok API 和 A2A

Grok API 是不同入口，使用你自己的 xAI 凭据和模型选择：

```powershell
$env:XAI_API_KEY = '你已有的 API 凭据'
$env:XAI_MODEL = '你的账号可用模型'
fl roundtable worker --url https://roundtable.example --room ROOM_ID --runtime grok
```

A2A 席位指向公开 Agent Card 可发现的 HTTPS 服务：

```powershell
# 服务需要认证时，配置 FULI_A2A_TOKEN。
fl roundtable worker --url https://roundtable.example --room ROOM_ID --runtime a2a --a2a-url https://agent.example
```

协议适配器不自动拥有对方服务的工具权限。服务需要人工输入/认证、取消未确认或协议不兼容时会显示实际阻塞；不会把模拟答复当作接通。

## 最有说服力的验收

1. 三台电脑，三个独立客户端，各用独立邀请。让 A 生成随机标记，B 引用并质疑，C 总结；退出并重开协调端，确认历史保留。
2. 协作任务由实现者生成实际文件/提交，再由独立审查者读取并给证据；用户最后验收。模型自报成功与人工接受分开显示。
3. 暂停时不发新回合，停止时工作端取消自己创建的进程。撤销 B 的邀请后，B 不能继续读历史、领取或提交。
4. 检查真实执行表：会话、模型、用量只能取自执行端。模型或会话未报告是未知；Token 用量缺失显示 `-`。API/协议夹具测试不是实际模型调用。

自动化验证：`node --test test/roundtable-*.test.js`。自动测试覆盖真实网络/MCP 会话与 SQLite 并发，但多台物理电脑和真实 Grok Bot 登录仍需你按上述步骤验证。实际发布验收记录会列出已通过的检查和未验证边界。
