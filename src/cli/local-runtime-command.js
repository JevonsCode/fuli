import {
  inspectLocalRuntime,
  openLocalConsole,
  restartLocalRuntime,
  startLocalRuntime,
  stopLocalRuntime
} from '../local-runtime/lifecycle.js';
import { detectAgents } from '../agent-kits/client-detection.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { agentTargets } from '../setup/agents.js';
import { resolveSetupPaths } from '../setup/paths.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  readRuntimeSettings,
  runtimeSettingsWithOverrides
} from '../system/runtime-settings.js';
import { portMoveSentence } from '../system/blocked-port-recovery.js';
import { parseLocalRuntimeOptions } from './local-runtime-options.js';
import { copyableValueStyle, writeLine } from './terminal-io.js';

export async function runLocalRuntimeCommand(command, args, dependencies = {}) {
  const options = parseLocalRuntimeOptions(command, args);
  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const env = dependencies.env ?? process.env;
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const readSettings = dependencies.readSettings ?? readRuntimeSettings;
  const savedSettings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const runtimeSettings = runtimeSettingsWithOverrides(savedSettings, {
    consolePort: options.port,
    lanAccess: options.lan
  });
  const write = dependencies.write ?? writeLine;
  const input = {
    ...options,
    port: runtimeSettings.ports.console,
    lan: runtimeSettings.lanAccess,
    runtimeSettings,
    paths,
    env,
    onProgress: write
  };
  const handlers = {
    start: dependencies.start ?? startLocalRuntime,
    stop: dependencies.stop ?? stopLocalRuntime,
    restart: dependencies.restart ?? restartLocalRuntime,
    status: dependencies.inspect ?? inspectLocalRuntime,
    open: dependencies.openConsole ?? openLocalConsole
  };
  // Read beside the start, through agent-installer (client-detection.js).
  const agentSetup = command === 'start'
    ? checkAgentSetup(dependencies.detectAgents
      ?? (() => detectAgents(agentKitPorts(paths, { env }).clientInstaller, agentTargets({ env, dataDir: paths.dataDir }))))
    : null;
  const result = await handlers[command](input, dependencies.lifecycleDependencies);
  const agentSetupCheck = agentSetup ? await agentSetup : null;
  const outputResult = agentSetupCheck
    ? { ...result, agentSetupCheck }
    : result;

  if (command === 'status' && options.json) {
    write(JSON.stringify(outputResult, null, 2));
  } else {
    write(formatLocalRuntimeResult(command, outputResult,
      copyableValueStyle({ output: dependencies.output, env })));
  }
  return {
    ...result,
    ...(agentSetupCheck ? { agentSetupCheck } : {}),
    exitCode: command === 'status' && result.status !== 'running'
      ? 1
      : result.status === 'partial' ? 1 : 0
  };
}

export function formatLocalRuntimeResult(command, result, copy = String) {
  if (command === 'start') {
    const title = result.status === 'running'
      ? 'Fuli local services are already running.'
      : 'Fuli local services started.';
    return formatStartedRuntime(title, result, copy);
  }
  if (command === 'restart') {
    return formatStartedRuntime('Fuli local services restarted.', result, copy);
  }
  if (command === 'stop') {
    if (result.status === 'partial') {
      return [
        'The local Fuli Provider stopped, but the unverified UI process was left running.',
        'Run fl status to inspect it without risking another process.'
      ].join('\n');
    }
    return result.console === 'not_running' && result.providers === 'not_initialized'
      ? 'Fuli local services have not been initialized.'
      : 'Fuli local services stopped. Graph data was preserved.';
  }
  if (command === 'open') return `Opened: ${copy(result.url)}`;
  if (command === 'status') return formatStatus(result, copy);
  throw new TypeError(`Unknown local runtime command: ${command}`);
}

function formatStartedRuntime(title, result, copy) {
  const lines = [title, ...(result.portMoves ?? []).map(portMoveSentence), `Management UI: ${copy(result.url)}`];
  const agentSetupNotice = formatAgentSetupNotice(result.agentSetupCheck);
  if (agentSetupNotice) lines.push(agentSetupNotice);
  if (result.lan === true) {
    lines.push(
      'LAN URLs:',
      ...result.lanUrls.map((url) => `  ${copy(url)}`),
      `Username: ${copy(result.lanAccess.username)}`,
      `Temporary access code: ${copy(result.lanAccess.accessCode)}`,
      'Use only on trusted Wi-Fi. Restarting LAN mode rotates the access code.'
    );
  }
  return lines.join('\n');
}

// The detected clients FULI is not fully connected in.
async function checkAgentSetup(detect) {
  try {
    const detection = await detect();
    if (detection.status !== 'available') return { status: 'unavailable', agents: [] };
    return { status: 'checked',
      agents: detection.agents.filter(({ available, integrationStatus }) => available && integrationStatus !== 'connected') };
  } catch {
    return { status: 'unavailable', agents: [] };
  }
}

function formatAgentSetupNotice(check) {
  if (!check) return null;
  if (check.status === 'unavailable') {
    return [
      'Could not verify Agent integrations.',
      'Run `fuli setup` to verify and update them.'
    ].join('\n');
  }
  if (!check.agents.length) return null;
  return [
    'Agent setup required:',
    ...check.agents.map((agent) => `  ${agent.label}: ${agentNeedsSetup(agent)}`),
    'Run `fuli setup` to install or update them.'
  ].join('\n');
}

function agentNeedsSetup(agent) {
  // agent-installer's component names.
  const detailLabels = {
    mcp: 'MCP',
    skills: 'Skills',
    hooks: 'Lifecycle hooks',
    instructions: 'Instructions',
    permissions: 'Permissions',
    plugin: 'Plugin'
  };
  const outdated = Object.entries(agent.integrationDetails ?? {})
    .filter(([, status]) => status !== 'current')
    .map(([key, status]) => `${detailLabels[key] ?? key}: ${status}`);
  return outdated.join(', ') || 'integration update available';
}

function formatStatus(result, copy) {
  const labels = {
    running: 'running',
    degraded: 'degraded',
    stopped: 'stopped',
    not_configured: 'not initialized',
    ready: 'ready',
    unavailable: 'unavailable',
    not_connected: 'not connected',
    not_configured_provider: 'not configured',
    unverified: 'identity unverified'
  };
  const publicSummary = result.public.configured
    ? `${labels[result.public.status] ?? result.public.status} (${result.public.providers.length} Providers)`
    : labels.not_connected;
  const lines = [
    `Fuli local status: ${labels[result.status] ?? result.status}`,
    `Management UI: ${labels[result.console.status] ?? result.console.status} · ${copy(result.console.url)}`,
    `Personal graph: ${providerLabel(result.personal.status, labels)}`,
    `Shared services: ${publicSummary}`
  ];
  if (result.adaptiveRuntime?.enabled) {
    const stages = {
      awake: 'awake',
      'provider-sleeping': 'Provider sleeping',
      sleeping: 'Provider and database sleeping',
      waking: 'waking',
      degraded: 'degraded',
      unknown: 'unknown'
    };
    lines.push(`Adaptive memory: ${stages[result.adaptiveRuntime.stage] ??
      result.adaptiveRuntime.stage}`);
  }
  if (result.version) lines.push(versionLine(result.version, result.console.status === 'ready'));
  return lines.join('\n');
}

// Status reads the running console's last npm answer and never asks npm itself.
function versionLine(version, consoleReady) {
  if (version.updateAvailable === true) {
    return `Version: ${version.installed} · v${version.latest} is available; run fuli update`;
  }
  if (version.updateAvailable === false) return `Version: ${version.installed} (latest)`;
  return `Version: ${version.installed} (not compared with npm: ${consoleReady
    ? 'the console has no answer yet' : 'the console is not running'})`;
}

function providerLabel(status, labels) {
  if (status === 'not_configured') return labels.not_configured_provider;
  if (status === 'sleeping') return 'sleeping on purpose';
  return labels[status] ?? status;
}
