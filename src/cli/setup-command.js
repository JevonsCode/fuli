import {
  applyAgentSelection,
  promptAgentSelection,
  shouldPromptForAgentSelection
} from './setup-agent-selection.js';
import { entryState } from '../agent-kits/client-detection.js';
import { parseSetupOptions } from '../setup/options.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { isRunnerDataDirectory } from '../runner/runner-mode.js';
import { forgetFollowerRuntime, localRuntimeLine, prepareInBackground, readLocalRuntime } from '../runner/follower-local-runtime.js';
import { setUpRunnerClients } from './runner-command.js';
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
import { reportingStartupFailure } from '../local-runtime/startup-failure.js';
import { startupStageWriter, withoutStageMarkers } from '../local-runtime/startup-stage.js';

export async function runSetupCommand(args, dependencies = {}) {
  const options = parseSetupOptions(args);
  // A runner (docs/runner.md) has no FULI of its own to set up: only its clients, which use the host.
  const dataDir = resolveSetupPaths({ dataDir: options.dataDir, env: dependencies.env ?? process.env }).dataDir;
  if ((dependencies.isRunner ?? isRunnerDataDirectory)(dataDir)) return setUpRunner(options, dataDir, dependencies);
  // This data directory's own FULI from now on: a follower's record of its graph no longer says what it holds.
  (dependencies.forgetFollowerRuntime ?? forgetFollowerRuntime)(dataDir);
  const planSetup = dependencies.planSetup ?? planLocalSetup;
  const applySetup = dependencies.applySetup ?? applyLocalSetup;
  const confirm = dependencies.confirm
    ?? (() => confirmInTerminal('Only the items above will change. Continue? [Y/n] ', { defaultYes: true }));
  const selectAgents = dependencies.selectAgents ?? promptAgentSelection;
  const write = dependencies.write ?? writeLine;
  const copy = copyableValueStyle({ output: dependencies.output, env: dependencies.env });
  // Detection may wait for another FULI's download of agent-installer, and says so.
  let plan = await planSetup(options, { ...dependencies, onProgress: write });
  if (options.connectedOnly) {
    plan = applyAgentSelection(plan, plan.agents.filter((agent) =>
      ['current', 'outdated'].includes(entryState(agent.integrationDetails))
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

  const env = dependencies.env ?? process.env;
  const result = await reportingStartupFailure(() => applySetup(plan, options, {
    ...dependencies,
    // The services a first start leaves running do not keep a client's ask for step lines.
    env: withoutStageMarkers(env),
    onProgress: write,
    // The phases of the first start, so a first setup is not silent through
    // the database install and the provider wait (startup-stage.js).
    onStage: startupStageWriter(write, env)
  }), { logPath: plan.paths?.logPath ?? null });
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

async function setUpRunner(options, dataDir, dependencies) {
  const write = dependencies.write ?? writeLine;
  write('This computer is a FULI runner: its FULI is on the host, so only its clients are set up here.');
  const agents = options.skipAgents ? []
    : await (dependencies.setupRunnerClients ?? setUpRunnerClients)({ dataDir, env: dependencies.env ?? process.env, write });
  for (const agent of agents) write(`  ${agent.label ?? agent.id}: ${agent.status}`);
  for (const agent of agents) for (const step of agent.nextSteps ?? []) write(`  ${agent.label ?? agent.id}: ${step}`);
  // Its own runtime, prepared in the background (docs/runner-roles-design.md §10); nothing is routed to it yet.
  const prepared = (dependencies.prepareLocalRuntime ?? prepareInBackground)({ dataDir });
  if (prepared) write('This computer\'s own runtime (Neo4j and the Provider) is being prepared in the background; '
    + 'calls keep going to the host. `fuli status` says when it is ready.');
  else write(localRuntimeLine((dependencies.readLocalRuntime ?? readLocalRuntime)(dataDir)).en);
  return { status: 'runner', agents, exitCode: agents.every(({ status }) => status === 'connected') ? 0 : 1 };
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
      ? `not possible here. ${plan.clientDetection.message} (${plan.clientDetection.reason})`
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
  // Listing a client is not the same as having it: a client FULI knows of but did
  // not find here is named, so "nothing to do" never passes for "all connected" (rec#90, rec#145).
  const missing = plan.agents.filter(({ available, inWsl }) => !available && !inWsl);
  if (missing.length) lines.push(`Not on this computer: ${missing.map(({ label }) => label).join(', ')}`);
  // A client only inside WSL reads its configuration there: FULI on Windows cannot connect it.
  const inWsl = plan.agents.filter(({ inWsl }) => inWsl);
  if (inWsl.length) {
    lines.push(`Installed only inside WSL, so FULI on this Windows cannot connect it: ${inWsl.map(({ label }) => label).join(', ')}. `
      + 'Run fuli setup inside WSL for it.');
  }
  if (
    runtimeMode !== 'native' &&
    plan.runtimeModeRecommendation?.recommendedMode === 'native'
  ) {
    lines.splice(3, 0,
      'Recommendation: native mode avoids shared VM memory on this low-memory Mac; ' +
      'select it with --runtime-mode native');
  }
  if (options.connectedOnly) {
    for (const agent of available.filter((agent) => agent.selected === false &&
      ['current', 'outdated'].includes(agent.integrationDetails?.skills))) {
      lines.push(`${agent.label}: skipped because there is no Fuli entry; existing Skills were left unchanged. Run fuli setup to reconnect.`);
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
  if (result.dataDirPrivate === false) {
    lines.push('Data directory: other accounts may still read it; the console\'s 体检 (doctor) can limit it to you and SYSTEM.');
  }
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
  if (result.clientDetection) lines.push(`Agent clients: not set up. ${result.clientDetection.message}`);
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
