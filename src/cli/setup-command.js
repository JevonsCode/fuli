import { createInterface } from 'node:readline/promises';

import {
  applyAgentSelection,
  promptAgentSelection,
  shouldPromptForAgentSelection
} from './setup-agent-selection.js';
import { parseSetupOptions } from '../setup/options.js';
import { applyLocalSetup, planLocalSetup } from '../setup/setup.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  runtimeSettingsWithOverrides
} from '../system/runtime-settings.js';

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
    write('Cancelled. No changes were made.');
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
    ? 'skipped'
    : selected.map(({ label }) => label).join(', ') || 'none detected';
  const runtimeSettings = plan.runtimeSettings ?? runtimeSettingsWithOverrides(
    DEFAULT_RUNTIME_SETTINGS,
    { consolePort: options.port }
  );
  const runtimeMode = runtimeSettings.graphRuntimeMode;
  const lines = [
    'Ready to set up Fuli',
    options.personalOnly
      ? 'Storage: personal only, using local Graphiti / Neo4j'
      : 'Storage: local Graphiti / Neo4j plus a development shared-project Provider',
    runtimeMode === 'native'
      ? 'Graph runtime: native processes; no Docker VM required'
      : 'Graph runtime: container; Docker or Rancher Desktop starts if needed',
    `Shared services: ${options.personalOnly ? 'not connected' : 'local development Provider'}`,
    `Personal space: ${options.personalSpaceName}`,
    `Neo4j memory: ${options.memoryProfile ?? 'saved profile or balanced default'}`,
    `Adaptive memory: ${plan.adaptiveRuntimeSettings?.enabled ?
      'enabled; Provider and database sleep after idle time' :
      'disabled; graph services stay running'}`,
    `Management UI: ${options.noStart
      ? 'will not start'
      : `http://127.0.0.1:${runtimeSettings.ports.console}`}`,
    `Agents: ${agentSummary}`
  ];
  if (
    runtimeMode !== 'native' &&
    plan.runtimeModeRecommendation?.recommendedMode === 'native'
  ) {
    lines.splice(3, 0,
      'Recommendation: native mode avoids shared VM memory on this low-memory Mac; ' +
      'select it with --runtime-mode native');
  }
  return lines.join('\n');
}

export function formatSetupResult(result, plan) {
  const lines = [result.status === 'ready'
    ? 'Fuli is ready.'
    : 'Fuli started, but one or more Agents are not connected.'];
  if (result.runtime.url) lines.push(`Open: ${result.runtime.url}`);
  if (result.runtime.lan === true) {
    lines.push(
      'LAN URLs:',
      ...result.runtime.lanUrls.map((url) => `  ${url}`),
      `Username: ${result.runtime.lanAccess.username}`,
      `Temporary access code: ${result.runtime.lanAccess.accessCode}`,
      'Use only on trusted Wi-Fi. Restarting LAN mode rotates the access code.'
    );
  }
  lines.push('Knowledge storage: Graphiti / Neo4j');
  for (const agent of result.agents) {
    if (agent.status === 'partial') {
      lines.push(`${agent.label}: partially configured; retry setup to finish installation`);
      continue;
    }
    if (agent.status !== 'connected') {
      lines.push(`${agent.label}: connection failed; retry setup later`);
      continue;
    }
    lines.push(agent.newTaskRequired
      ? `${agent.label}: connected; create or reopen a task to load the new configuration`
      : `${agent.label}: connected`);
    for (const step of agent.nextSteps ?? []) lines.push(`${agent.label}: ${step}`);
  }
  return lines.join('\n');
}

async function confirmInTerminal() {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await input.question('Only the items above will change. Continue? [Y/n] '))
      .trim()
      .toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    input.close();
  }
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
