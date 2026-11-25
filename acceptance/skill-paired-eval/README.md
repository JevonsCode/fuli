# 单一 Skill 配对评测

这个验收评测只回答一个问题：**同一个任务、同一个客户端和模型，把一条已经存下来的
工作流版本“用上”和“不用”各跑一次，实际输出有没有差别。**

一次运行只选**恰好一条**已存工作流版本。它不评估一组 Skill，不组合多个工作流，也不把
工作流的步骤写进任务提示词。两臂的正面任务完全相同，客户端和模型相同，各自在全新的临时
目录里开始；选中版本的步骤只出现在 on 臂，形式是一个客户端原生发现的 Skill。负向对照是
同一份 Skill 加在一个无关任务上，用来量“误触发”。

## 边界

- 工作流库只读打开，评估不会提出、确认、停用工作流，也不会写运行记录。库还是旧格式时
  直接拒绝，不替人迁移。
- 每个臂在系统临时目录里建一个干净工作区，跑完删除；输出、文件内容和验收检查写进结果
  目录。不读写真实用户项目，不改生产数据。
- 不执行场景里的任何代码或命令；场景只有文本文件、任务提示和检查项。
- `deterministic` 模式是 CI 接缝，使用场景声明或内置的替身，**不是真实客户端证据**。它
  只证明选择、两臂、评分、负向对照和结果格式能工作。要谈客户端行为，必须用 `opencode`
  模式实际运行。
- `opencode` 模式会向配置的模型提供方**发送模型请求**（网络请求和模型计费都可能发生），
  这是预期行为。是否实际执行只按每个臂的 `step_finish` 事件确认；没有完成步骤时不会声称
  提供方已执行。它不会连接生产 MCP 服务、插件或其他 FULI 状态。
- 一次配对只说明这一次；要形成产品结论，仍需足量、同条件、随机顺序的配对任务（见
  `FULI_ALIGNMENT_BENCHMARK.md` 第 8 节）。

## 运行方式

安装 FULI 后，这个评测随包提供为 `fuli-skill-eval`：

```bash
fuli-skill-eval --store "<数据目录>/agent-workflows.sqlite" --list
```

在源码树里 `npm run measure:skill-paired -- <参数>`（或 `node acceptance/skill-paired-eval/run.js <参数>`）
与它等价；下面的示例统一写安装后的 `fuli-skill-eval`。

## 选择一条真实保存的工作流

工作流库是 FULI 数据目录下的 `agent-workflows.sqlite`（Windows 默认
`%LOCALAPPDATA%\Fuli`，Linux 默认 `~/.local/share/fuli`，也可用 `FULI_DATA_DIR` 指定）。
先看紧凑索引（不显示步骤）：

```bash
fuli-skill-eval --store "<数据目录>/agent-workflows.sqlite" --list
```

可以按人/Agent 过滤：

```bash
fuli-skill-eval --store "<...>" --list \
  --personal-space-id <spaceId> --agent-id <agentId>
```

索引里有 `workflowId`、当前状态、生效版本、显示版本、步骤数、名称。选定一条后按需查看它
的版本和步骤：

```bash
fuli-skill-eval --store "<...>" --workflow-id <workflowId> --show
```

默认使用当前生效版本；`--version <n>` 可以显式评测一个存下来的旧版本或草案。报告会写明
`active: false`，不会把它说成已确认或正在使用。`--show` 和报告都会在存在时给出这条版本
保存的课程触发条件、适用范围、易错点、验收证据，以及工作图验收，而不只是有序步骤。

## 场景：默认 fixture 或自己的 JSON

不传 `--scenario` 时用内置 fixture：出版社风格的版本号文本，任务读 `VERSION` 和
`NOTES.md` 写出 `release.txt`，负向对照是“17 + 25”。也可以给一个小型声明式 JSON：

```bash
fuli-skill-eval \
  --store "<...>/agent-workflows.sqlite" --workflow-id <workflowId> \
  --scenario "<FULI 安装目录>/acceptance/skill-paired-eval/scenarios/changelog.json" \
  --mode deterministic --out "<测试目录>/results"
```

（源码树里把 `<FULI 安装目录>/` 换成仓库根目录。）

场景格式（`scenario.js` 会先校验，再创建任何工作区或结果目录）：

```json
{
  "name": "可选，报告里的场景名",
  "files": { "PACKAGE": "2.3.1\n", "CHANGELOG.md": "# Changelog\n" },
  "positive": {
    "id": "changelog-entry",
    "prompt": "任务提示……",
    "checks": [
      { "type": "file-equals", "path": "CHANGELOG.md", "value": "……" },
      { "type": "file-unchanged", "path": "PACKAGE" },
      { "type": "only-changed", "allowed": ["CHANGELOG.md"] }
    ],
    "standIn": { "offFiles": { "…": "…" }, "onFiles": { "…": "…" } }
  },
  "negative": {
    "id": "unrelated-multiplication",
    "prompt": "无关任务……",
    "checks": [{ "type": "file-equals", "path": "answer.txt", "value": "69" }],
    "forbidden": { "files": ["CHANGELOG.md"], "markers": ["[fix]"] },
    "standIn": { "files": { "answer.txt": "69\n" } }
  }
}
```

- `files` 是工作区初始文本；`positive` 和 `negative` 分别是两臂任务和负向对照。
- 检查类型只有 `file-equals`、`file-unchanged`、`only-changed`、`output-excludes`。
- OpenCode 的 `output-excludes` 检查助手回答，负向对照还检查实际改动的文件。原始事件流和诊断保存在 `result.json`，技能读取单独计入 `skillRead`。
- `standIn` 只给 `deterministic` 模式：off/on 两臂各写什么，负向对照写什么。
- 路径只能是工作区内的相对路径：拒绝绝对路径、盘符、反斜杠、`.`/`..`、控制字符、
  `TASK.md`/`AGENTS.md`/`opencode.json`/`.opencode`/`.git`。在 Windows 上这些控制文件名按
  大小写不敏感比较（`task.md`、`OPENCODE.JSON`、`.GIT` 同样拒绝），因为那里它们是同一个
  文件。文件数、单文件大小、总量都有上限，未知字段直接拒绝，因此场景里藏不了命令、回调或
  工作区外的路径。

## 跑一对

确定性接缝（CI 和流程自检）：

```bash
fuli-skill-eval \
  --store "<测试目录>/fixture/agent-workflows.sqlite" \
  --workflow-id workflow-release-tag \
  --mode deterministic --out "<测试目录>/results"
```

真实 OpenCode 客户端（必须显式给模型；两臂相同，不允许按臂覆盖）：

```bash
fuli-skill-eval \
  --store "<...>/agent-workflows.sqlite" \
  --workflow-id <workflowId> \
  --mode opencode --model "ccc/deepseek-v4.1-flash" \
  --client-command "$HOME/.opencode/bin/opencode" \
  --provider-config ~/.config/opencode/opencode.json \
  --out "<测试目录>/results"
```

要求并校验：

- OpenCode **v2**（当前机器 `opencode v2.2.5`）。版本不是 v2 时整个运行记为 unavailable。
- `--client-command` 必须是原生可执行文件。`.cmd`/`.bat` 包装器会被明确拒绝：这类入口会
  把 argv 交给 shell，破坏参数边界。Windows 上请传 `opencode.exe` 或原生二进制。
- 进程始终 `shell: false`，参数按 argv 原样传递；提示词里的引号、`--session` 等字样都只是
  提示词内容，不会变成命令。
- 没有 `--client-arg`/`--client-env`：客户端参数固定，避免某个臂恢复会话、改模型或改工作
  目录。
- `--pair-id` 只能是一个可移植的目录名（字母或数字开头，只含字母、数字、`.`、`_`、`-`），
  不是路径，不能是 `.`/`..`、Windows 设备名或以 `.` 结尾。结果目录以独占方式创建：同名的
  既有目录会让运行直接失败并说明原因，重试必须换一个 id，不会覆盖上一次的报告和证据。

每个臂都有**全新的临时工作区**和**全新的隔离 HOME**（`HOME`/`XDG_*` 都指向临时目录，
`PWD` 也指向该工作区）。`--provider-config` 只复制所选模型的那一个 provider 条目到临时
`opencode.json`，不加载其中的 MCP、插件或其它凭据；配置里 `mcp`/`plugin` 为空，
快照和分享关闭，工具只留 `skill`，Skill 权限只允许选中版本对应的那一个 id。每个臂是一个
独立 `--standalone` 进程和新会话，不传 `--continue`/`--session`。

on 臂把选中的版本写成 `.opencode/skills/<slug>/SKILL.md` 这一个项目 Skill；off 臂不写。
`skill` 每次调用都记录 id、状态和错误，用来区分“实际读取了所选 Skill”和“只是条件上
可能用到”。客户端不能写文件：它只返回一个 JSON 文件映射，由可信的评测器在工作区内校验
并写入。返回体缺 JSON、路径越界、符号链接、非普通文件或超出上限时，该臂记为 unavailable，
不会算通过。

谨慎使用真实数据：`--store` 指向真实 FULI 库时，只读取选中版本；工作流内容会出现在结果
和临时工作区里。不要把含个人内容的结果目录公开。

## 结果怎么读

每次运行写到 `--out/<pair-id>/`：

- `result.json`：两个正面臂和一个负向对照臂的输入状态、实际 stdout/stderr、改动文件内容、
  逐项检查、pass、修正次数（能观察到才算，否则写 unknown）和 unavailable 原因；还有选中的
  工作流、版本、来源、人确认记录、客户端身份、存储哈希和工作流库是否未被改变。
- 每个臂的 `evidence`：`transcript`（OpenCode JSON 事件流）、`toolCalls`、
  `skillRead`/`skillReadExpected`、`skillCallStatus` 和 `skillError`、`artifactFiles`、
  `providerContact`、`upstreamExecution`（`confirmed`/`not_confirmed`/`unknown`）、
  `requestedModel` 与 `reportedModel`，以及 `tokens`。`tokens` 只汇总客户端
  `step_finish` 事件报告的值（输入、输出、推理、缓存读、缓存写），逐步累加并设上限；没有
  报告、字段非法或超出上限时写 `unknown`，不估算、不按字节推算。`providerContact` 只表示
  这个隔离客户端被配置为访问模型提供方；只有出现完成的模型步骤才把 `upstreamExecution`
  记为 `confirmed`，所以“发了请求”不会被说成“上游确认执行”。步骤事件里没有实际
  provider/model 时，`reportedModel` 就是 `null`（未知），与请求的模型分开保存。
- `report.md`：同一结果的中文摘要，逐臂写明实际读取了所选 Skill、没有读取（条件上可能
  忽略，输出不能归因于它）、还是未提供 Skill；并给出两臂的墙钟耗时和客户端报告的 token
  （没有就写未知）。

验收规则在 `grading.js`，两个模式共用：文件内容相等、文件未改、只改允许的文件、客户端
正常退出，以及负向对照的禁止文件/标记。只读取普通本地文件：符号链接、非普通文件和超过
单文件/总量上限的内容会被跳过并记录原因，不会当成证据。负向对照只有在实际运行并看完输出
后才写 `measured: true`；没跑或客户端不可用时写明原因，不写“未误触发”。负向对照把
`skillRead` 和实际输出效果（`outputEffect`：改动文件、新文件、命中的标记）分开记录，
读没读 Skill 不参与 pass 判定。

退出码：正面 on 臂通过、负向对照没有误触发、工作流库未改变且没有 unavailable 时为 0；
否则为 1，细节在结果里。

## 测试

```bash
node --test test/skill-paired-eval.test.js
```

测试只用合成数据：真实保存的 fixture 库、确定性接缝、第二个无关场景、只读选择、场景校验、
符号链接跳过、argv 保留、`.cmd` 拒绝、缺客户端命令时的 unavailable，以及 `--pair-id`
校验与同名结果目录的独占失败、Windows 大小写控制名、负向对照的 Skill 读取/输出效果分离、
耗时与客户端报告 token（没有报告时写未知）。没有一个测试调用模型或读写真实 FULI 数据。
