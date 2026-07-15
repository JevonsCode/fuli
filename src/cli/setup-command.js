import { createInterface } from 'node:readline/promises';

import { parseSetupOptions } from '../setup/options.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';

export async function runSetupCommand(args, dependencies = {}) {
  const options = parseSetupOptions(args);
  const planSetup = dependencies.planSetup ?? planLocalSetup;
  const applySetup = dependencies.applySetup ?? applyLocalSetup;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const write = dependencies.write ?? writeLine;
  const plan = planSetup(options, dependencies);
  write(formatSetupPreview(plan, options));

  if (!options.yes && !await confirm()) {
    write('已取消，没有修改任何内容。');
    return { status: 'cancelled' };
  }

  const result = await applySetup(plan, options, dependencies);
  write(formatSetupResult(result, plan));
  return result;
}

export function formatSetupPreview(plan, options) {
  const detected = plan.agents.filter(({ available }) => available).map(({ label }) => label);
  return [
    '准备设置复利',
    `本地数据：${plan.paths.dataDir}`,
    `个人空间：${options.personalSpaceName}`,
    `本地控制台：${options.noStart ? '暂不启动' : `http://127.0.0.1:${options.port}`}`,
    `Agent：${options.skipAgents ? '跳过接入' : detected.join('、') || '未检测到'}`
  ].join('\n');
}

export function formatSetupResult(result, plan) {
  const lines = [result.status === 'ready' ? '复利已准备好。' : '复利已启动，但有 Agent 未连接。'];
  if (result.runtime.url) lines.push(`打开：${result.runtime.url}`);
  lines.push(`数据库：${plan.paths.dbPath}`);
  for (const agent of result.agents) {
    lines.push(agent.status === 'connected'
      ? `${agent.label}：已连接`
      : `${agent.label}：连接失败，请稍后重试 setup`);
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
