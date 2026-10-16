import { createInterface } from 'node:readline/promises';

import { FULI_PACKAGE_NAME } from '../package-metadata.js';
import { parseUninstallOptions } from '../setup/options.js';
import { applyLocalUninstall, planLocalUninstall, removalTarget } from '../setup/uninstall.js';

export async function runUninstallCommand(args, dependencies = {}) {
  const options = parseUninstallOptions(args);
  const planUninstall = dependencies.planUninstall ?? planLocalUninstall;
  const applyUninstall = dependencies.applyUninstall ?? applyLocalUninstall;
  const confirm = dependencies.confirm ?? confirmInTerminal;
  const write = dependencies.write ?? writeLine;
  const plan = planUninstall(options, dependencies);
  write(formatUninstallPreview(plan));

  if (!options.yes && !await confirm()) {
    write('Cancelled. No changes were made.');
    return { status: 'cancelled' };
  }

  const result = await applyUninstall(plan, dependencies);
  write(formatUninstallResult(result));
  return result;
}

export function formatUninstallPreview(plan) {
  const labels = plan.agents.map(({ label }) => label).join(', ') || 'none';
  const removal = removalTarget(plan.paths);
  return [
    'Ready to remove local Fuli integrations',
    'Local services: stop',
    `Agent integrations: ${labels}`,
    'Skills: remove only copies identical to this package; preserve locally modified copies',
    `Data: preserve ${plan.paths.dataDir}`,
    ...(removal.kind === 'portable_folder' ? [] : ['Neo4j volumes: preserve']),
    ...(removal.dataInside ? [portableDataWarning(removal)] : [])
  ].join('\n');
}

export function formatUninstallResult(result) {
  const lines = [
    result.status === 'ready'
      ? 'Local Fuli integrations were removed.'
      : 'Some local Fuli integrations could not be removed.',
    `Data preserved: ${result.data.path}`,
    ...finalRemovalLines(result.removal ?? { kind: 'npm_global' })
  ];
  if (result.runtime.status !== 'stopped') {
    lines.push(`Local services: ${result.runtime.message ?? 'could not safely confirm they stopped'}`);
  }
  for (const agent of result.agents) {
    const modified = agent.skills.some(({ status }) => status === 'preserved_modified');
    if (modified) lines.push(`${agent.label}: preserved a locally modified Skill`);
    if (agent.errors?.length) lines.push(`${agent.label}: ${agent.errors.join('; ')}`);
  }
  return lines.join('\n');
}

function finalRemovalLines(removal) {
  if (removal.kind !== 'portable_folder') {
    return [`Finally, remove the global command: npm uninstall --global ${FULI_PACKAGE_NAME}`];
  }
  return [
    `Finally, after the local services have stopped, delete this portable folder: ${removal.path}`,
    ...(removal.dataInside ? [portableDataWarning(removal)] : [])
  ];
}

function portableDataWarning(removal) {
  return `Warning: the data directory is inside the portable folder; move it out of ${removal.path} first if you want to keep it.`;
}

async function confirmInTerminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('Remove local integrations? [y/N] ')).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
