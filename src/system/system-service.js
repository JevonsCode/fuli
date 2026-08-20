import { readJsonFile } from '../storage/json-file.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  normalizeRuntimeSettings,
  readRuntimeSettings,
  runtimeSettingsEqual,
  writeRuntimeSettings
} from './runtime-settings.js';
import { createResourceMonitor } from './resource-monitor.js';
import { createAdaptiveRuntimeBroker } from '../adaptive-runtime/runtime-broker.js';
import { readAdaptiveRuntimeSettings } from '../adaptive-runtime/settings.js';

export function createSystemService({
  paths,
  packageRoot,
  activePort,
  activeLan,
  readJson = readJsonFile,
  readSettings = readRuntimeSettings,
  writeSettings = writeRuntimeSettings,
  executorAdapters = new Map(),
  runtimeBroker = createAdaptiveRuntimeBroker({
    paths,
    settings: readAdaptiveRuntimeSettings(paths.adaptiveRuntimeSettingsPath),
    executorAdapters
  }),
  resourceMonitor = createResourceMonitor({
    dataDir: paths.dataDir,
    packageRoot,
    runtimeMode: readSettings(paths.runtimeSettingsPath).graphRuntimeMode,
    nativeProcessStatePath: paths.nativeProcessStatePath,
    nativePersonalDir: paths.nativePersonalDir,
    nativeWorkspaceDir: paths.nativeWorkspaceDir
  })
}) {
  function activeSettings() {
    const state = readJson(paths.graphRuntimeStatePath, null);
    const graphConfig = readJson(paths.graphRuntimeConfigPath, null);
    return settingsFromActiveRuntime({
      state,
      graphConfig,
      activePort,
      activeLan
    });
  }

  function getSettings() {
    const active = activeSettings();
    const configured = readSettings(paths.runtimeSettingsPath, { fallback: active });
    return settingsResult(configured, active);
  }

  function updateSettings(input) {
    const configured = writeSettings(paths.runtimeSettingsPath, input);
    return settingsResult(configured, activeSettings());
  }

  return {
    getSettings,
    updateSettings,
    resources: () => resourceMonitor.sample(),
    runtimeStatus: () => runtimeBroker.status(),
    acquireRuntimeLease: (input) => runtimeBroker.acquire(input),
    refreshRuntimeLease: (leaseId) => runtimeBroker.refresh(leaseId),
    releaseRuntimeLease: (leaseId) => runtimeBroker.release(leaseId),
    withGraphRuntimeLease: (owner, operation) => runtimeBroker.withLease(
      { kind: 'graph', owner },
      operation
    ),
    withExecutorRuntimeLease: (executorId, owner, operation) => runtimeBroker.withLease(
      { kind: 'executor', executorId, owner },
      operation
    ),
    close: () => runtimeBroker.close()
  };
}

export function settingsFromActiveRuntime({
  state,
  graphConfig,
  activePort,
  activeLan
}) {
  let settings = DEFAULT_RUNTIME_SETTINGS;
  if (state?.runtimeSettings) {
    try {
      settings = normalizeRuntimeSettings(state.runtimeSettings);
    } catch {
      settings = DEFAULT_RUNTIME_SETTINGS;
    }
  }
  const ports = { ...settings.ports };
  const consolePort = integerPort(state?.port) ?? integerPort(activePort);
  if (consolePort !== null) ports.console = consolePort;
  const personalProvider = urlPort(graphConfig?.personal?.providerUrl);
  if (personalProvider !== null) ports.personalProvider = personalProvider;
  const managedWorkspace = (graphConfig?.workspaces ?? []).find((workspace) =>
    workspace?.managedDevelopment === true || isLoopbackProvider(workspace?.providerUrl)
  );
  const workspaceProvider = urlPort(managedWorkspace?.providerUrl);
  if (workspaceProvider !== null) ports.workspaceProvider = workspaceProvider;
  return normalizeRuntimeSettings({
    ...settings,
    ports,
    lanAccess: state?.lan === true || (state == null && activeLan === true)
  });
}

function settingsResult(configured, active) {
  return {
    configured,
    active,
    restartRequired: !runtimeSettingsEqual(
      {
        ...configured,
        resourceRefreshSeconds: active.resourceRefreshSeconds,
        conversationLaunchers: active.conversationLaunchers
      },
      active
    )
  };
}

function integerPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function urlPort(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return integerPort(url.port || (url.protocol === 'https:' ? 443 : 80));
  } catch {
    return null;
  }
}

function isLoopbackProvider(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}
