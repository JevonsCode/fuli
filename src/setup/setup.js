import { installAgent } from './install-agent.js';
import { existsSync } from 'node:fs';
import { totalmem } from 'node:os';
import { detectAgents } from '../agent-kits/client-detection.js';
import { CLIENT_COMPONENT_UNAVAILABLE } from '../agent-kits/client-installer.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { resolveSetupPaths } from './paths.js';
import { ensureGraphRuntime } from './graph-runtime.js';
import { beginFirstRunCapture } from './first-run-capture.js';
import { reconcileLocalKnowledge } from '../knowledge-hard-delete/reconcile-local.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  readRuntimeSettings,
  runtimeSettingsWithOverrides
} from '../system/runtime-settings.js';
import { readReservedPortRanges, withoutReservedPorts } from '../system/reserved-ports.js';
import {
  DEFAULT_ADAPTIVE_RUNTIME_SETTINGS,
  adaptiveRuntimeSettingsWithOverrides,
  readAdaptiveRuntimeSettings
} from '../adaptive-runtime/settings.js';

// detect: the clients agent-installer finds on this machine
// (client-detection.js detectAgents), for the setup paths.
export async function planLocalSetup(options, {
  env = process.env,
  resolvePaths = resolveSetupPaths,
  detect = (paths) => detectAgents(agentKitPorts(paths, { env }).clientInstaller),
  readSettings = readRuntimeSettings,
  readAdaptiveSettings = readAdaptiveRuntimeSettings,
  settingsExist = existsSync,
  readReservedRanges = readReservedPortRanges,
  platform = process.platform,
  hostTotalMemory = totalmem
} = {}) {
  const paths = resolvePaths({ dataDir: options.dataDir, env });
  const savedRuntimeSettings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const requestedSettings = runtimeSettingsWithOverrides(savedRuntimeSettings, {
    consolePort: options.port,
    graphRuntimeMode: options.runtimeMode
  });
  // A first setup on Windows keeps clear of the port ranges the system reserves
  // now; saved settings and a port the person chose are kept as they are.
  const firstSetup = !(paths.runtimeSettingsPath && settingsExist(paths.runtimeSettingsPath));
  const runtimeSettings = firstSetup && options.port === null
    ? { ...requestedSettings, ports: withoutReservedPorts(requestedSettings.ports, readReservedRanges({ platform })) }
    : requestedSettings;
  const savedAdaptiveRuntimeSettings = paths.adaptiveRuntimeSettingsPath
    ? readAdaptiveSettings(paths.adaptiveRuntimeSettingsPath)
    : DEFAULT_ADAPTIVE_RUNTIME_SETTINGS;
  const adaptiveRuntimeSettings = adaptiveRuntimeSettingsWithOverrides(
    savedAdaptiveRuntimeSettings,
    { enabled: options.adaptiveMemory ?? null }
  );
  const detection = options.skipAgents ? { status: 'available', agents: [] } : await detect(paths);
  const detected = detection.status === 'available' ? detection.agents : [];
  const agents = options.codexOnly
    ? detected.filter(({ id }) => id === 'codex')
    : detected;
  return {
    paths,
    runtimeSettings,
    // The mode this data last ran in, before any --runtime-mode override.
    savedRuntimeMode: savedRuntimeSettings.graphRuntimeMode,
    runtimeModeRecommendation: graphRuntimeModeRecommendation({
      platform,
      hostTotalBytes: hostTotalMemory()
    }),
    adaptiveRuntimeSettings,
    agents,
    // Why no client could be detected, when agent-installer was unavailable.
    ...(detection.status === 'available' ? {}
      : { clientDetection: { status: 'unavailable', reason: detection.reason, message: CLIENT_COMPONENT_UNAVAILABLE } })
  };
}

function graphRuntimeModeRecommendation({ platform, hostTotalBytes }) {
  const lowMemoryMac = platform === 'darwin' &&
    Number.isFinite(hostTotalBytes) &&
    hostTotalBytes <= 16 * 1024 ** 3;
  return {
    recommendedMode: lowMemoryMac ? 'native' : 'container',
    reason: lowMemoryMac ? 'low-memory-mac' : 'default',
    hostTotalBytes
  };
}

export async function applyLocalSetup(plan, options, dependencies = {}) {
  const ensureRuntime = dependencies.ensureRuntime ?? ensureGraphRuntime;
  // Stubbed runtimes in tests never touch the data directory they name.
  const beginFirstRun = dependencies.beginFirstRun ?? (ensureRuntime === ensureGraphRuntime ? beginFirstRunCapture : () => {});
  const runtimeSettings = plan.runtimeSettings ?? runtimeSettingsWithOverrides(
    DEFAULT_RUNTIME_SETTINGS,
    { consolePort: options.port }
  );
  beginFirstRun(plan.paths);
  const runtime = await ensureRuntime({
    paths: plan.paths,
    personalSpaceName: options.personalSpaceName,
    port: runtimeSettings.ports.console,
    lan: runtimeSettings.lanAccess,
    runtimeSettings,
    runtimeMode: runtimeSettings.graphRuntimeMode,
    savedRuntimeMode: plan.savedRuntimeMode,
    personalOnly: options.personalOnly,
    memoryProfile: options.memoryProfile,
    adaptiveRuntimeSettings: plan.adaptiveRuntimeSettings,
    noStart: options.noStart,
    allowProviderDowngrade: options.allowProviderDowngrade === true,
    env: dependencies.env ?? process.env,
    onProgress: dependencies.onProgress
  });
  // Every client is written through agent-installer (client-installer.js).
  const selected = plan.agents.filter(({ available, selected }) => available && selected !== false);
  const installer = selected.length
    ? dependencies.clientInstaller ?? agentKitPorts(plan.paths, { env: dependencies.env ?? process.env }).clientInstaller
    : null;
  const agents = [];
  for (const agent of selected) agents.push(await installAgent(installer, agent));

  const agentsReady = agents.every(({ status }) => status === 'connected');
  const reconcileKnowledge = dependencies.reconcileKnowledge
    ?? (ensureRuntime === ensureGraphRuntime ? reconcileLocalKnowledge : null);
  const knowledgeRecovery = agentsReady && reconcileKnowledge
    ? await reconcileKnowledge(plan.paths, { fetchImpl: dependencies.fetchImpl ?? globalThis.fetch }) : null;
  // Without agent-installer no client was set up: setup does not finish ready.
  return {
    status: agentsReady && !plan.clientDetection && knowledgeRecovery?.status !== 'pending' ? 'ready' : 'partial',
    ...(knowledgeRecovery ? { knowledgeRecovery } : {}),
    ...(plan.clientDetection ? { clientDetection: plan.clientDetection } : {}),
    runtime,
    agents
  };
}
