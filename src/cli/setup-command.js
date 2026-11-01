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
import { confirmInTerminal, copyableValueStyle, interactiveTerminal, writeLine } from './terminal-io.js';
import { askCaptureScope, captureScopeSummary } from './capture-scope-prompt.js';
import { captureOnboardingFor } from '../setup/first-run-capture.js';
import { setupMigrationNotice } from '../data-format/format-notices.js';
import { knowledgeReconciliationMessage } from '../knowledge-hard-delete/reconcile-local.js';
import { formatShadowedLaunchers, inspectUpdateInstallation } from './update-installation.js';
import { quoteShellArgument } from './shell-argument.js';
import { portMoveSentence } from '../system/blocked-port-recovery.js';

export async function runSetupCommand(args, dependencies = {}) {
  const options = parseSetupOptions(args);
  const planSetup = dependencies.planSetup ?? planLocalSetup;
  const applySetup = dependencies.applySetup ?? applyLocalSetup;
  const confirm = dependencies.confirm
    ?? (() => confirmInTerminal('Only the items above will change. Continue? [Y/n] ', { defaultYes: true }));
  const selectAgents = dependencies.selectAgents ?? promptAgentSelection;
  const write = dependencies.write ?? writeLine;
  const copy = copyableValueStyle({ output: dependencies.output, env: dependencies.env });
  let plan = await planSetup(options, dependencies);
  if (options.connectedOnly) {
    plan = applyAgentSelection(plan, plan.agents.filter((agent) =>
      ['current', 'outdated'].includes(agent.integrationDetails?.mcp)
    ).map(({ id }) => id));
  } else if (shouldPromptForAgentSelection(plan, options)) {
    const detected = plan.agents.filter(({ available }) => available);
    plan = applyAgentSelection(plan, await selectAgents(detected));
  }
  write(formatSetupPreview(plan, options, copy));

  if (!options.yes && !await confirm()) {
    write('Cancelled. No changes were made.');
    return { status: 'cancelled' };
  }

  const result = await applySetup(plan, options, {
    ...dependencies,
    onProgress: write
  });
  write(formatSetupResult(result, plan, copy));
  // Stubbed setups in tests never read the data directory they name.
  const onboardingFor = dependencies.captureOnboarding ?? (applySetup === applyLocalSetup ? captureOnboardingFor : null);
  const captureScope = onboardingFor && plan.paths
    ? await firstRunCaptureScope(onboardingFor(plan.paths), options, result, dependencies) : null;
  if (captureScope) write(captureScope);
  // Stubbed setups in tests name no real data directory either.
  const migrationNotice = dependencies.migrationNotice ?? (applySetup === applyLocalSetup ? setupMigrationNotice : null);
  const waiting = migrationNotice && plan.paths?.dataDir ? await migrationNotice(plan.paths.dataDir) : null;
  if (waiting) write(waiting.replaceAll('fuli migrate preview', copy('fuli migrate preview')));
  // Stubbed setups in tests leave the host PATH alone too.
  const shadowedLaunchers = dependencies.shadowedLaunchers ?? (applySetup === applyLocalSetup
    ? () => formatShadowedLaunchers(inspectUpdateInstallation({ env: dependencies.env ?? process.env })) : null);
  const shadowed = shadowedLaunchers?.();
  if (shadowed) write(shadowed);
  return { ...result, exitCode: result.status === 'partial' ? 1 : 0 };
}

// A new installation asks where FULI records (rec#5 C10): here when a person
// is at the terminal, otherwise in the console, with recording off meanwhile.
async function firstRunCaptureScope(onboarding, options, result, dependencies) {
  if (!onboarding.state().ask) return null;
  const interactive = !options.yes && (dependencies.interactive ?? interactiveTerminal)();
  const choice = interactive ? await (dependencies.askCaptureScope ?? askCaptureScope)() : null;
  const outcome = choice ? onboarding.answer({ choice }, { surface: 'terminal' }) : null;
  return captureScopeSummary(outcome, result.runtime?.url ?? null);
}

export function formatSetupPreview(plan, options, copy = String) {
  const available = plan.agents.filter(({ available }) => available);
  const selected = available.filter(({ selected }) => selected !== false);
  const agentSummary = options.skipAgents || (available.length > 0 && selected.length === 0)
    ? 'skipped'
    : plan.clientDetection
      ? `clients could not be detected (${plan.clientDetection.reason})`
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
      : copy(`http://127.0.0.1:${runtimeSettings.ports.console}`)}`,
    `Automatic client setup: ${agentSummary}`,
    `Other MCP clients: connect after setup with ${copy('fuli connect')} (no model required)`
  ];
  if (
    runtimeMode !== 'native' &&
    plan.runtimeModeRecommendation?.recommendedMode === 'native'
  ) {
    lines.splice(3, 0,
      'Recommendation: native mode avoids shared VM memory on this low-memory Mac; ' +
      'select it with --runtime-mode native');
  }
  if (options.connectedOnly) {
    for (const agent of available.filter((agent) => agent.selected === false && agent.skillPath &&
      ['current', 'outdated'].includes(agent.integrationDetails?.skills))) {
      lines.push(`${agent.label}: skipped because there is no Fuli MCP entry; existing Skills were left unchanged. Run fuli setup to reconnect.`);
    }
  }
  return lines.join('\n');
}

export function formatSetupResult(result, plan, copy = String) {
  const lines = [result.status === 'ready'
    ? 'Fuli is ready.'
    : result.knowledgeRecovery?.status === 'pending'
      ? 'Fuli setup needs knowledge recovery before local stores are ready.'
      : 'Fuli started, but one or more Agents are not connected.'];
  if (result.knowledgeRecovery) lines.push(knowledgeReconciliationMessage(result.knowledgeRecovery));
  lines.push(...(result.runtime.portMoves ?? []).map(portMoveSentence));
  if (result.runtime.url) lines.push(`Open: ${copy(result.runtime.url)}`);
  if (result.runtime.lan === true) {
    lines.push(
      'LAN URLs:',
      ...result.runtime.lanUrls.map((url) => `  ${copy(url)}`),
      `Username: ${copy(result.runtime.lanAccess.username)}`,
      `Temporary access code: ${copy(result.runtime.lanAccess.accessCode)}`,
      'Use only on trusted Wi-Fi. Restarting LAN mode rotates the access code.'
    );
  }
  lines.push('Knowledge storage: Graphiti / Neo4j');
  for (const agent of result.agents) {
    if (agent.status !== 'connected') {
      const state = agent.status === 'partial' ? 'partially configured' : 'connection failed';
      lines.push(`${agent.label}: ${state}${agent.message ? ` (${agent.message})` : ''}; retry fuli setup`);
      continue;
    }
    const checkNote = agent.selfCheck?.status === 'passed' ? ' (self-check passed)' : '';
    lines.push(agent.restartRequired
      ? `${agent.label}: connected${checkNote}; quit and reopen the app to load Fuli`
      : agent.newTaskRequired
        ? `${agent.label}: connected${checkNote}; create or reopen a task to load the new configuration`
        : `${agent.label}: connected${checkNote}`);
    for (const step of agent.nextSteps ?? []) lines.push(`${agent.label}: ${step}`);
  }
  if (result.status === 'ready' && result.agents.some((agent) => agent.status === 'connected')) {
    lines.push(
      'First-try check: 1) Tell one connected client a collaboration preference; 2) Ask another connected client what Fuli remembers.'
    );
  }
  if (result.agents.some((agent) => agent.status === 'connected' &&
    !agent.restartRequired && !agent.newTaskRequired)) {
    lines.push('After a package upgrade, reconnect Fuli in already-open clients or restart the clients, then open a new task. Existing MCP processes are not replaced automatically.');
  }
  const dataDir = plan?.paths?.dataDir;
  lines.push(`Other MCP clients: run ${copy('fuli connect')} and merge the fuli entry into your MCP settings.`);
  if (dataDir) lines.push(`For this installation, use ${copy(`--data-dir ${quoteShellArgument(dataDir)}`)}.`);
  lines.push('MCP provides tools and memory. Automatic conversation capture and wake/resume require a client adapter.');
  return lines.join('\n');
}
