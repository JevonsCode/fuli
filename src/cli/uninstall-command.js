import { createInterface } from 'node:readline/promises';

import { FULI_PACKAGE_NAME } from '../package-metadata.js';
import { parseUninstallOptions } from '../setup/options.js';
import { applyLocalUninstall, planLocalUninstall } from '../setup/uninstall.js';

export async function runUninstallCommand(args, dependencies = {}) {
  const options = parseUninstallOptions(args);
  const planUninstall = dependencies.planUninstall ?? planLocalUninstall;
  const applyUninstall = dependencies.applyUninstall ?? applyLocalUninstall;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const write = dependencies.write ?? writeLine;
  const plan = planUninstall(options, dependencies);
  write(formatUninstallPreview(plan));

  if (!options.yes && !await confirm()) {
    write('已取消，没有修改任何内容。');
    return { status: 'cancelled' };
  }

  const result = await applyUninstall(plan, dependencies);
  write(formatUninstallResult(result));
  return result;
}

export function formatUninstallPreview(plan) {
  const labels = plan.agents.map(({ label }) => label).join('、') || '无';
  return [
    '准备清理复利的本机接入',
    '本地服务：停止',
    `Agent 接入：${labels}`,
    'Skills：仅删除与当前安装包完全一致的副本；有本地修改的会保留',
    `数据：保留 ${plan.paths.dataDir}`,
    'Neo4j 数据卷：保留'
  ].join('\n');
}

export function formatUninstallResult(result) {
  const lines = [
    result.status === 'ready' ? '复利本机接入已清理。' : '复利本机接入未完全清理。',
    `数据已保留：${result.data.path}`,
    `最后移除全局命令：npm uninstall --global ${FULI_PACKAGE_NAME}`
  ];
  if (result.runtime.status !== 'stopped') {
    lines.push(`本地服务：${result.runtime.message ?? '未能安全确认已停止'}`);
  }
  for (const agent of result.agents) {
    const modified = agent.skills.some(({ status }) => status === 'preserved_modified');
    if (modified) lines.push(`${agent.label}：保留了有本地修改的 Skill`);
    if (agent.errors?.length) lines.push(`${agent.label}：${agent.errors.join('；')}`);
  }
  return lines.join('\n');
}

async function confirmInTerminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('继续清理本机接入？[y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
