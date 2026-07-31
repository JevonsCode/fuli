# 复利（Fuli）

复利是一个面向 AI Agent 的本地优先上下文图谱。它让 Codex、Claude Code 和
Cursor 在会话之间复用个人偏好、项目约束、历史决策与 Runbook，同时保留来源和
知识边界。

当前 npm 版本是个人版：个人知识与管理界面运行在本机。团队共享 Provider 是独立的
服务部署单元，不作为第二个用户 npm 包发布。

## 安装

准备：

- Node.js 24.12 或更高版本
- Docker Compose v2；Docker Desktop 或 Rancher Desktop 均可
- 至少约 4 GB 可供容器使用的内存

全局安装并初始化：

```bash
npm install --global fuli-context
fuli setup
```

`fuli setup` 会先展示即将进行的操作，再请求确认。它会检查容器运行时、初始化本机
Graphiti / Neo4j、创建个人空间、安装配套 Agent Skills，并为检测到的 Agent 注册
`fuli` MCP。Codex 接入还会在用户级 `AGENTS.md` 中合并一段很短的 Bootstrap：每个
用户任务开始时先调用协作偏好工具，并把当前工作目录作为 `projectPath` 传给 Fuli。
偏好正文仍以 Fuli 为唯一来源，不会复制到 Codex 配置中。默认不会连接或模拟团队共享
Provider。

初始化完成后：

```bash
fuli open
```

管理界面默认位于 `http://127.0.0.1:2727`。

## CLI 使用

全局安装会提供两个等价命令：

- `fuli`：完整命令名，文档默认使用它；
- `fl`：短别名，例如 `fl status` 与 `fuli status` 完全相同。

查看版本和内置帮助：

```bash
fuli --version
fuli --help
```

### 本地服务与安装

| 命令 | 用途 |
| --- | --- |
| `fuli setup [选项]` | 初始化 Provider、管理界面、Agent 接入和 Skills；可重复执行 |
| `fuli start [选项]` | 启动本机服务 |
| `fuli stop [--data-dir DIR]` | 安全停止本机服务并保留数据 |
| `fuli restart [选项]` | 重启本机服务 |
| `fuli status [--json]` | 查看服务状态；`--json` 输出机器可读结果 |
| `fuli open` | 在浏览器中打开管理界面 |
| `fuli update [setup 选项]` | 更新全局 npm 包，并用新版 CLI 刷新本机接入 |
| `fuli uninstall [--yes]` | 清理 Agent 接入和服务，保留知识数据 |

常用示例：

```bash
fuli start
fuli start --open
fuli status
fuli status --json
fuli restart
fuli restart --rebuild
fuli stop
```

`fuli stop` 只停止本机服务，不删除图谱数据。

`start` 和 `restart` 可使用 `--data-dir DIR`、`--personal-space NAME`、`--port PORT`；
`--open` 会在启动后打开管理界面，`--rebuild` 会重新构建本机 Provider 容器。

### setup 选项

| 选项 | 用途 |
| --- | --- |
| `--yes` | 跳过确认，适合无人值守执行 |
| `--data-dir DIR` | 使用指定数据目录；后续命令应继续传入同一路径 |
| `--personal-space NAME` | 设置首次初始化时的个人空间名称，默认是 `我` |
| `--port PORT` | 设置管理界面端口，默认是 `2727` |
| `--codex-only` | 只接入 Codex |
| `--skip-agents` | 不修改 Agent 配置，也不刷新 Agent Skills |
| `--no-start` | 初始化 Provider，但不启动管理界面 |
| `--personal-only` | 只使用个人 Provider；这是默认模式 |
| `--with-dev-public` | 同时启动本机开发用公共 Provider，仅用于开发或联调 |

例如，无人值守地完成默认初始化：

```bash
fuli setup --yes
```

使用自定义数据目录和管理界面端口：

```bash
fuli setup --data-dir "./fuli-data" --port 3727
```

只初始化 Provider、不启动管理界面：

```bash
fuli setup --no-start
```

## 更新

```bash
fuli update
```

`fuli update` 默认先展示更新计划并请求确认。需要无人值守执行时：

```bash
fuli update --yes
```

更新流程会先查询 npm 的 `latest` 版本；确认不会降级后，才安全停止旧版服务、安装当时
的 `fuli-context@latest` 对应版本，再直接使用新安装版本的 CLI 执行 `setup --yes`。
既有知识数据、配置备份和 Neo4j 数据卷不会删除；即使 npm 上已经是当前版本，也会刷新
Agent 接入和配套 Skills。`update` 支持上表中的全部 setup 选项；使用过自定义数据目录、
端口或 Provider 模式时，应在更新时重复传入相同选项。

如果当前 CLI 来自尚未发布的工作区版本，并且版本号高于 npm `latest`，更新会在停止服务
和安装包之前退出，避免把开发版本降级。

如果当前已安装版本尚不识别 `update`，需要先手动升级一次到包含该命令的版本：

```bash
npm install --global fuli-context@latest
fuli setup --yes
```

如果自动更新在 npm 安装或新版 setup 阶段失败，知识数据仍会保留。检查命令输出后可用
上面两条命令恢复；使用过自定义 setup 选项时也要一并带上。

## 卸载

先清理 Agent 接入，再移除全局 npm 包：

```bash
fuli uninstall
npm uninstall --global fuli-context
```

`fuli uninstall` 会：

- 停止本机 Fuli 服务；
- 从 Codex、Claude Code 和 Cursor 中移除 Fuli MCP 接入；
- 只删除仍与当前安装包完全一致的 Fuli Skills，有本地修改的 Skill 会保留；
- 保留个人图谱、配置备份与 Neo4j 数据卷。

这样重新安装时可以继续使用原数据。数据永久删除不包含在自动卸载流程中，避免误删。

## 个人版边界

- 个人知识写入本机 Provider。
- Agent 归纳结构化知识，不保存整段会话。
- Token、Cookie、私钥、凭据、临时日志与原始命令输出不会写入图谱。
- Graphiti 的远程 LLM 路径被禁用；当前嵌入在本机计算。
- 搜索按个人空间和项目范围显式限定，不会默认混入所有项目。
- Fuli 不是实时监控或 Git 服务；实时错误和代码状态应从对应的监控、日志或 Git
  工具获取。

团队共享能力将通过单独部署的 Provider 提供。个人版 npm 继续作为本地 CLI、管理界面
和 Agent 接入客户端，避免用户同时安装两个容易混淆的全局命令包。

## Agent 工作方式

Fuli 为支持的 Agent 安装两个用户级 Skills：

- `capturing-session-knowledge`：按稳定知识边界检索和静默沉淀上下文；
- `grilling-project`：帮助用户审视和补全个人项目资料。

Codex 的用户级 Bootstrap 要求 Agent 在每个用户任务开始时、调用其他工具或回答之前，
调用 `get_collaboration_preferences`。调用只把当前工作目录作为瞬时 `projectPath`
传给本机 Fuli；绝对路径不会写入图谱，也不会出现在工具结果中。Fuli 在 MCP 服务端
完成匹配：个人全局的品味、个性与判断偏好始终生效；只有仓库根、Codex worktree 的
原仓库，或工作区内唯一的精确子项目对应一个已登记个人项目时，才叠加该项目偏好。
模糊、多项目、待确认、已失效、冲突或其他项目的偏好不会进入实际生效列表。首次写入
或更新 Bootstrap 后，新建或重新打开一个 Codex 任务，让用户级 `AGENTS.md` 重新加载；
此后偏好修改会在下一次用户任务中重新读取，不需要重启 Codex。

疑似冲突既可以立即人工处理，也可以标记为“交给 AI，使用时处理”。后者不会提前覆盖
任何一条记录；只有后续任务确实需要相关偏好时，Agent 才会先比较双方并调用专用解决
工具。解决结果会保留修订历史，并标明该偏好曾发生冲突、由 AI 处理及其判断依据。
协作偏好页顶部的“已确认”“待确认”“疑似冲突”均为可点击入口；“待确认”会筛出对应
记录并打开首条详情，可继续确认、纠正或标记失效。

主要 MCP 工具包括：

| 工具 | 用途 |
| --- | --- |
| `get_collaboration_preferences` | 获取当前会话实际生效的全局与项目级协作偏好 |
| `resolve_deferred_preference_conflict` | 在相关任务首次使用前解决已交给 AI 的偏好冲突并留下审计标记 |
| `capture_session_knowledge` | 批量写入个人知识或创建发布预审草稿 |
| `search_knowledge_graph` | 在明确范围内查询个人偏好与项目知识 |
| `get_knowledge_graph` | 获取有界节点—关系图 |
| `list_knowledge_spaces` | 查看个人空间、项目与订阅 |
| `upsert_personal_project` | 新建或更新个人项目资料 |
| `revise_personal_knowledge` | 修正、失效或恢复个人知识 |
| `get_graphiti_status` | 检查 Provider 与 Graphiti 状态 |

## 本机服务

| 服务 | 默认地址 |
| --- | --- |
| 个人 Neo4j Browser / Bolt | `127.0.0.1:7474` / `127.0.0.1:7687` |
| 个人 Provider | `127.0.0.1:8787` |
| Fuli 管理界面 | `127.0.0.1:2727` |

如果端口被占用、Docker Compose 不可用或容器引擎未启动，setup 会在修改 Agent 配置前
停止，并给出对应错误。

## 源码开发

```bash
npm install
npm test
npm run test:package
```

Provider 验证：

```bash
python3 -m compileall -q graph-provider/fuli_graph
python3 -m pytest -q graph-provider/tests
docker compose -f compose.graphiti.yml config --quiet
```

`npm run test:package` 会构建前端、生成真实 npm tarball、安装到隔离的全局前缀，并验证
`fuli` / `fl`、版本号、帮助信息和已发布 Web UI。测试源码、QA 截图与内部设计文档
都不会进入 npm 包。

## License

[Apache-2.0](LICENSE)
