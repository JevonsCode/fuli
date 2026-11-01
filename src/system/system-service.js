import { join } from 'node:path';

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
import { createPackageVersionChecker } from './package-version-checker.js';
import { clientConnectionConfig } from '../setup/client-connection.js';
import { agentTargets } from '../setup/agents.js';
import { createClientConnectionObserver } from './client-connection-status.js';
import { createClientInstaller } from './client-connection-install.js';
import { createSettingsApplier } from './settings-apply.js';
import { consoleUpdate } from './console-update.js';
import { createDoctor } from './doctor.js';
import { createDoctorRepair } from './doctor-repair.js';
import { createDiagnosticsBundle } from './diagnostics-bundle.js';
import { liveMcpProcesses } from '../mcp/process-registry.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { sessionClientRecords } from '../agent-kits/session-clients.js';
import { createSessionOffers } from '../agent-kits/session-offers.js';
import { customClientStore } from '../agent-kits/custom-clients.js';
import { createCustomClients } from './custom-client-connection.js';
import { CODEX_HOOK_TRUST_CLIENT } from '../agents/codex/hook-trust.js';
import { readFormatOperations } from '../data-format/operations-log.js';

export function createSystemService({
  paths,
  runtimeConfigPath = paths.graphRuntimeConfigPath,
  packageRoot,
  activePort,
  activeLan,
  readJson = readJsonFile,
  readSettings = readRuntimeSettings,
  writeSettings = writeRuntimeSettings,
  settingsApplier = createSettingsApplier({ paths, writeSettings }),
  agentKits = agentKitPorts(paths, { runtimeConfigPath }),
  customClients = customClientStore({ extensionsDir: agentKits.clientInstaller.extensionsDir }),
  clientObserver = createClientConnectionObserver({
    installer: agentKits.clientInstaller,
    targets: () => agentTargets({ dataDir: paths.dataDir }),
    customClients,
    historyPath: join(paths.dataDir, 'client-connection-observations.json')
  }),
  clientInstaller = createClientInstaller({ paths, runtimeConfigPath, installer: agentKits.clientInstaller }),
  executorAdapters = new Map(),
  versionChecker = createPackageVersionChecker(),
  update = consoleUpdate(paths.dataDir),
  // The data format plan (migration-plan.js) the doctor reads; null without a local installation.
  previewDataFormats = null,
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

  const configuredSettings = () => readSettings(paths.runtimeSettingsPath, { fallback: activeSettings() });
  const sessionOffers = createSessionOffers({ launcher: agentKits.sessionLauncher, configPath: paths.launcherHostConfigPath,
    readLaunchers: () => configuredSettings().conversationLaunchers, records: sessionClientRecords(paths.dataDir) });
  // The launcher's host configuration follows the settings whenever they are
  // read or written; a failure to write it only leaves the launcher on the last one.
  const syncLauncherConfig = () => { try { sessionOffers.syncHostConfig(); } catch { /* next read retries */ } };

  function getSettings() {
    const active = activeSettings();
    const configured = readSettings(paths.runtimeSettingsPath, { fallback: active });
    syncLauncherConfig();
    return { ...settingsResult(configured, active), apply: settingsApplier.status() };
  }

  async function updateSettings(input) {
    const configured = normalizeRuntimeSettings(input, { strict: true });
    const active = activeSettings();
    const result = settingsResult(configured, active);
    if (settingsApplier.status()?.status === 'applying') {
      throw new TypeError('Settings are already being applied. Please wait.');
    }
    if (result.restartRequired) {
      const previous = readSettings(paths.runtimeSettingsPath, { fallback: active });
      result.apply = await settingsApplier.prepare(configured, {
        ...previous, ports: active.ports, lanAccess: active.lanAccess, graphRuntimeMode: active.graphRuntimeMode,
      });
    } else {
      writeSettings(paths.runtimeSettingsPath, configured);
      syncLauncherConfig();
    }
    return result;
  }

  const observeClients = () => clientObserver.observe();
  const doctor = createDoctor({ observeClients, previewDataFormats,
    formatOperations: () => readFormatOperations(paths.dataDir), graphStage: () => runtimeBroker.status().stage,
    hookTrustUnreadable: [CODEX_HOOK_TRUST_CLIENT],
    liveProcesses: () => liveMcpProcesses(runtimeConfigPath), latestVersion: () => versionChecker.peek(),
    lastUpdate: () => update.status(),
    portMoves: () => {
      const state = readJson(paths.graphRuntimeStatePath, null);
      return state?.portMoves ? { movedAt: state.startedAt, moves: state.portMoves } : null;
    } });

  // The 诊断包 a person previews and exports (diagnostics-bundle.js); reading
  // settings for it never syncs the launcher's configuration as getSettings does.
  const diagnostics = createDiagnosticsBundle({ paths, doctor: () => doctor.check(), installKind: () => update.kind(),
    settings: () => ({ configured: configuredSettings(), active: activeSettings() }) });

  return {
    getSettings,
    updateSettings,
    startSettingsApply: (id) => settingsApplier.start(id),
    settingsApplyStatus: () => settingsApplier.status(),
    clientConnection: () => Object.fromEntries(['standard', 'vscode', 'server'].map((format) => [
      format, clientConnectionConfig({ nodePath: paths.clientNodePath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath }, format)
    ])),
    clientConnectionStatus: observeClients,
    // Whether the console offers to open recorded sessions (session-offers.js).
    sessionLaunchOffers: (sessions) => sessionOffers.offers(sessions),
    connectClient: clientInstaller,
    // Clients the person describes by hand (custom-client-connection.js).
    ...createCustomClients({ installer: agentKits.clientInstaller, store: customClients }),
    resources: () => resourceMonitor.sample(),
    // updateKind: how the console's one-click update installs it (console-update.js).
    versionStatus: async () => ({ ...await versionChecker.check(), updateKind: update.kind() }),
    // The checker's last answer without asking npm (`fuli status`); 'unchecked' before its first.
    cachedVersionStatus: () => versionChecker.peek() ?? { status: 'unchecked' },
    updateStatus: () => update.status(),
    startUpdate: async ({ stopProcesses } = {}) => {
      const version = await versionChecker.check();
      return update.start({ version: version.updateAvailable ? version.latestVersion : null, stopProcesses });
    },
    // FULI's 体检 and its repair of what needs no person (doctor.js, doctor-repair.js).
    doctor: () => doctor.check(),
    diagnostics,
    repairDoctor: createDoctorRepair({ check: doctor.check, connectClient: clientInstaller, observeClients,
      recordClientsReconnected: (id) => update.recordClientsReconnected(id) }),
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
    workspace?.managedDevelopment === true || (
      isLoopbackProvider(workspace?.providerUrl)
      && [8788, settings.ports.workspaceProvider].includes(urlPort(workspace?.providerUrl))
    )
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
        conversationLaunchers: active.conversationLaunchers,
        notifications: active.notifications,
        agentNamingStyle: active.agentNamingStyle,
        topicPromotion: active.topicPromotion
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
