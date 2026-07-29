import { createInterface } from 'node:readline/promises';

import {
  applyAgentSelection,
  promptAgentSelection,
  shouldPromptForAgentSelection
} from './setup-agent-selection.js';
import { parseSetupOptions } from '../setup/options.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';

export async function runSetupCommand(args, dependencies = {}) {
  const options = parseSetupOptions(args);
  const planSetup = dependencies.planSetup ?? planLocalSetup;
  const applySetup = dependencies.applySetup ?? applyLocalSetup;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const selectAgents = dependencies.selectAgents ?? promptAgentSelection;
  const write = dependencies.write ?? writeLine;
  let plan = planSetup(options, dependencies);
  if (shouldPromptForAgentSelection(plan, options)) {
    const detected = plan.agents.filter(({ available }) => available);
    plan = applyAgentSelection(plan, await selectAgents(detected));
  }
  write(formatSetupPreview(plan, options));

  if (!options.yes && !await confirm()) {
    write('已取消，没有修改任何内容。');
    return { status: 'cancelled' };
  }

  const result = await applySetup(plan, options, {
    ...dependencies,
    onProgress: write
  });
  write(formatSetupResult(result, plan));
  return result;
}

export function formatSetupPreview(plan, options) {
  const available = plan.agents.filter(({ available }) => available);
  const selected = available.filter(({ selected }) => selected !== false);
  const agentSummary = options.skipAgents || (available.length > 0 && selected.length === 0)
    ? '跳过接入'
    : selected.map(({ label }) => label).join('、') || '未检测到';
  return [
    '准备设置复利',
    options.personalOnly
      ? '存储：仅个人：本机 Graphiti / Neo4j'
      : '存储：本机 Graphiti / Neo4j + 团队共享项目 Provider',
    '容器运行时：自动检测；已安装但未运行时会自动启动',
    `公共服务：${options.personalOnly ? '暂不连接' : '连接本机开发 Provider'}`,
    `个人空间：${options.personalSpaceName}`,
    `本地控制台：${options.noStart ? '暂不启动' : `http://127.0.0.1:${options.port}`}`,
    `Agent：${agentSummary}`
  ].join('\n');
}

export function formatSetupResult(result, plan) {
  const lines = [result.status === 'ready' ? '复利已准备好。' : '复利已启动，但有 Agent 未连接。'];
  if (result.runtime.url) lines.push(`打开：${result.runtime.url}`);
  lines.push('知识存储：Graphiti / Neo4j');
  for (const agent of result.agents) {
    if (agent.status !== 'connected') {
      lines.push(`${agent.label}：连接失败，请稍后重试 setup`);
      continue;
    }
    lines.push(agent.newTaskRequired
      ? `${agent.label}：已连接；请新建或重新打开一个任务以加载新配置`
      : `${agent.label}：已连接`);
  }
  return lines.join('\n');
}

async function confirmInTerminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('只会修改以上内容，继续？[Y/n] ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
