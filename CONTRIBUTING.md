# Contributing to Fuli / 参与复利

Help make the first successful use reproducible: connect a client, resolve the right project,
recover useful context, and report what actually happened. Documentation fixes, small regression
tests, and redacted installation reports are welcome alongside code changes.

欢迎从一次可复现的安装反馈、一条文档修正或一个小回归测试开始。请先阅读
[工程规则](AGENTS.md)、[中文使用说明](README.zh-CN.md)和[验收入口](acceptance/README.md)。

## Choose an entry point / 从哪里开始

| You want to… / 想做的事 | Start here / 入口 |
| --- | --- |
| Report installation or first-use trouble / 安装或首次使用卡住 | [Installation issue form](https://github.com/JevonsCode/fuli/issues/new?template=installation.yml) |
| Share a real Codex → Claude Code result / 提交真实跨客户端结果 | Follow the [Chinese handoff runbook](acceptance/cross-client-handoff.md), then use the [acceptance form](https://github.com/JevonsCode/fuli/issues/new?template=cross-client-acceptance.yml) |
| Fix wording or a broken instruction / 修正文案或操作步骤 | Open a small pull request with the old instruction, corrected instruction, and how you checked it |
| Change behavior / 修改行为 | Describe the observable problem and add a focused regression test in the owning module |

Check existing [issues](https://github.com/JevonsCode/fuli/issues) and
[pull requests](https://github.com/JevonsCode/fuli/pulls) before starting a larger change.
These links and forms are contribution entry points, not claims that a report, issue label,
or live acceptance run already exists.

## Run the source / 运行源码

Use Node.js **24.12+**. From the repository root:

```sh
npm ci
npm test
```

`npm test` builds the web assets, checks web types, and runs the Node and web suites.
For a focused change, start with the relevant commands below; run the full affected suites before
submitting a pull request. Provider work uses Python 3.12 in a virtual environment:

```sh
python -m pip install "./graph-provider[dev]"
python -m pytest -q graph-provider/tests
```

For package contents or setup changes, also run `npm run test:package`.
See [development requirements](README.md#acceptance-and-development) and
[live acceptance](acceptance/README.md) for container/runtime prerequisites.
Live acceptance may start services, write isolated test data, or invoke paid clients; read the
specific runbook before running it. A unit test pass does not prove a client loaded its Hook.

## Small contributions with clear checks / 可从这些小改动开始

These are bounded starting points, not reserved issues or confirmed bugs. First reproduce the
gap on your version; if it is already covered, contribute the missing explanation or evidence.

| Small contribution | Existing code or test to start from | Focused verification |
| --- | --- | --- |
| Clarify one misleading setup state, especially installed files versus a loaded client Hook / 解释一个接入状态 | `src/setup/agent-installation-status.js`, `test/setup-agent-installation-status.test.js` | `node --test test/setup-agent-installation-status.test.js test/setup-agent-selection.test.js` |
| Add one project-path edge case with expected match or explicit ambiguity / 补一个目录识别用例 | `src/graphiti/project-path-context.js`, `test/project-path-context.test.js` | `node --test test/project-path-context.test.js` |
| Improve one handoff failure instruction, such as changed prompt text or an incomplete transcript boundary / 让接续失败可恢复 | `test/conversation-handoff.test.js`, `docs/agent-conversations-and-collaboration.md` | `node --test test/conversation-handoff.test.js test/conversation-transcript.test.js` |
| Improve the copy/resume experience without exposing another project's conversation / 改善复制接续指令 | `web/src/features/project-agents/AgentConversations.spec.ts` | `npm run test:web -- web/src/features/project-agents/AgentConversations.spec.ts` |
| Add a missing source or unknown-value case in worker receipts / 补执行回执的来源边界 | `test/project-agent-worker-runtime.test.js` | `node --test test/project-agent-worker-runtime.test.js` |
| Submit one redacted real-client result on a documented version / 补真实客户端证据 | `acceptance/cross-client-handoff.md` | Complete each applicable evidence row; mark anything unrun explicitly |

Application code should normally be plain JavaScript. Keep domain behavior, storage, transport,
and UI responsibilities separate. Put unavoidable client-specific behavior in its client adapter;
common MCP contracts and reusable Skills should remain Agent-agnostic. Preserve historical facts
when correcting the current answer. Visible loading states reuse `GrowthLoading.vue` with labels
that describe the actual request in Chinese and English.

## Submit a reviewable change / 提交可审查的改动

Keep one pull request focused on one problem. Explain the trigger, expected and observed behavior,
what changed, and the exact checks you ran. Include skipped checks and their reasons. For UI work,
include a redacted screenshot when it explains the change. For client integration work, report
client versions and distinguish configuration inspection, protocol tests, and a real host session.

Before submitting:

```sh
git diff --check
```

Review the diff for unrelated edits and machine-specific data. Do not include API keys, bearer
tokens, passwords, runtime configuration files, full personal transcripts, or private project
contents. Use a small synthetic example and keep only the fields needed to reproduce the issue.
Replace private paths and identities with consistent aliases. A task-context token is a credential,
not an evidence identifier. Token **usage counts** are fine when their source and scope are clear.

请在报告中保留版本、错误码、发生步骤与脱敏后的实际结果。没有测过就写“未运行”；
服务不可用就写“阻塞”。不要把安装成功、mock 通过或配置里存在某位 Agent 写成真实协作完成。
