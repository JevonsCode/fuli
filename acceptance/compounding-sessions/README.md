# 复利曲线：FULI 越用越省吗

rec#88 之前的多轮测量只看冷启动的单个会话，FULI 在那里只能加成本。这个评测看的是一个项目被连续使用时的曲线：同一个合成项目（Tidewater，通知转发服务）上 9 个先后发生的任务，每个任务一个全新的 Claude Code 无头会话，后面的任务要用到前面定下或踩到的东西。

| 会话 | 任务 | 需要前面的 |
| --- | --- | --- |
| s1 | email 渠道加重试（用户在提示里说明重试策略） | 生成 spec fixtures 才能跑测试 |
| s2 | SMS 用“和 email 一样的”重试 | 重试策略、`src/retry.js` 的 `withRetry`、fixtures |
| s3 | 新增 webhook 渠道，按项目约定 | 重试策略、渠道约定、错误码约定、`npm run check`、fixtures |
| s4 | `GET /healthz`，测试在 e2e 端口上起服务 | e2e 端口、fixtures |
| s5 | 未知渠道报规范的错误 | 错误码约定、`npm run check`、fixtures |
| s6 | 排查各渠道偏离重试策略的地方（起始状态里 SMS 延迟和 webhook 的 4xx 重试被改过，测试也一起改了） | 重试策略、fixtures |
| s7 | 失败日志带上错误码；用户顺口说了推送服务商的沙箱地址和密钥请求头，以及值班告警标题的规则 | fixtures |
| s8 | 新增 push 渠道，发到推送服务商的沙箱 | s7 说的沙箱地址和请求头（代码里没有）、重试策略、约定 |
| s9 | `alertTitle()` 按值班命名规则格式化告警标题 | s7 说的命名规则（代码里没有） |

s7–s9 量的是 FULI 的真实场景：事实只在用户说过的话里，从来不写进代码。off 臂只能猜或者重新问（无头模式问不了），所以 s8、s9 会做错。

两臂：

- `off`：没有 FULI，每个会话只有仓库。
- `fuli`：FULI 的 Claude Code hook 和 MCP，接一个隔离的 FULI。每个重复一个新的个人项目（`tw-<tag>-r<n>`），所以 FULI 从不知道 Tidewater 开始，并在 6 个会话里保留它学到的东西。

每个会话开始时，仓库都由 `workspace.js` 重建为同一个参考状态：基础项目 + 前面各会话的参考答案（`solutions/sN`）+ 本会话的起始覆盖（`start/sN`）。所以两臂看到的代码完全一样，只差 Agent 记得什么。成功 = 本会话的隐藏检查（`checks.js`）全部通过，其中包括项目自己的测试套件，以及任务要求时的 `npm run check`。

隔离：`--strict-mcp-config`（off 没有 MCP），`--settings`（off 为空），`--setting-sources project,local`，`CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`（不加载任何 CLAUDE.md），`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（关掉 Claude Code 自己的记忆），所以跨会话唯一的记忆是 FULI。用本机已登录的 Claude Code，不读也不复制凭据。只用合成数据：`--fuli-config` 和 `--fuli-data-dir` 必须指向隔离的 FULI，不能是真实安装，也不能调用 2727/2828。

## 运行

```bash
node acceptance/compounding-sessions/run.js --out <结果目录> --tag base --reps 2 \
  --fuli-config <含 mcp.json 和 settings.json 的目录> --fuli-data-dir <隔离 FULI 的数据目录>
node acceptance/compounding-sessions/summarize.js --out <结果目录> --tag base
```

- `--fuli-config` 里的两个文件由 FULI 自己的 Claude Code 客户端安装代码生成，指向隔离实例（rec#88 的 `gen-claude-config.mjs`）。隔离实例要先打开采集（capture policy `enabled: true`），否则 checkpoint 写不进知识。
- 两臂、各重复串行执行：s4 的测试绑定固定端口，重活也不并行。`--max-cost` 是 Claude Code 报告的标价金额上限。
- 每个会话记录：全部输入（未缓存 + 缓存读 + 缓存写）、缓存读、输出、费用、模型请求数、工具调用（探索 / 编辑 / 运行 / FULI / 其他，以及失败的运行）、入口 hook 字节、checkpoint 内容、隐藏检查各项。汇总的头条是“每个通过任务的 token”：全部输入 + 输出之和除以通过的会话数；每格给中位数和区间（最小–最大）。`summarize.js --off-tag` 可以从别的标签读 off 臂。

`test/compounding-sessions-eval.test.js` 不调模型，只验证评测本身成立：每个会话开始时检查不通过，参考答案通过同一检查。
