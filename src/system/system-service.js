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
import { createClientConnectionObserver } from './client-connection-status.js';
import { createClientInstaller } from './client-connection-install.js';
import { createSettingsApplier } from './settings-apply.js';
import { consoleUpdate } from './console-update.js';
import { createDoctor } from './doctor.js';
import { createDoctorRepair } from './doctor-repair.js';
import { createDiagnosticsBundle } from './diagnostics-bundle.js';
import { readGraphMigration, startGraphMigration } from './graph-migration.js';
import { createLogRetention } from './log-retention.js';
import { liveMcpProcesses, sessionsAwaitingRestart } from '../mcp/process-registry.js';
import { agentKitPorts } from '../agent-kits/ports.js';
import { sessionClientRecords } from '../agent-kits/session-clients.js';
import { createSessionOffers } from '../agent-kits/session-offers.js';
import { createNewSessions } from '../agent-kits/new-sessions.js';
import { createCliPresence } from '../agent-kits/cli-presence.js';
import { customClientStore } from '../agent-kits/custom-clients.js';
import { createCustomClients } from './custom-client-connection.js';
import { CODEX_HOOK_TRUST_CLIENT, createCodexHookTrust } from '../agents/codex/hook-trust.js';
import { createTranscriptFormatProbe } from '../agents/transcript-format-registry.js';
import { readFormatOperations } from '../data-format/operations-log.js';
import { createModelCapture } from '../debug-turns/model-capture.js';
import { windowsDataAcl } from './windows-data-acl.js';
import { debugTurnStore } from '../debug-turns/store.js';
import { runningMcpServers } from './mcp-process-scan.js';
import { isDesktopAppPackage } from '../desktop/desktop-app-package.js';
import { createNpmCopyControl } from '../desktop/npm-copy-control.js';
import { createCliPathControl } from '../desktop/cli-path.js';
import { readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { createWhatsNew } from '../whats-new/whats-new.js';
import { desktopClientOpensLinks } from '../desktop/desktop-client-links.js';

const MCP_SCAN_CACHE_MS = 5 * 60_000;

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
  // Codex's /fla prompt files (src/agents/codex/fla-prompts.js), kept while the console runs.
  codexFlaPrompts = null,
  agentKits = agentKitPorts(paths, { runtimeConfigPath,
    ...(codexFlaPrompts ? { clientPrompts: () => ({ codex: codexFlaPrompts.prompts() }) } : {}) }),
  customClients = customClientStore({ extensionsDir: agentKits.clientInstaller.extensionsDir }),
  clientObserver = createClientConnectionObserver({
    installer: agentKits.clientInstaller,
    customClients,
    historyPath: join(paths.dataDir, 'client-connection-observations.json'),
    awaitingRestart: () => sessionsAwaitingRestart(runtimeConfigPath)
  }),
  clientInstaller = createClientInstaller({ installer: agentKits.clientInstaller }),
  executorAdapters = new Map(),
  versionChecker = null,
  update = consoleUpdate(paths.dataDir),
  // Only the desktop app's console looks after npm copies beside it; for an npm installation the copy is FULI itself.
  npmCopyControl = isDesktopAppPackage(packageRoot) ? createNpmCopyControl({ dataDir: paths.dataDir, ownRoot: packageRoot }) : null,
  // The desktop app's own fl and fuli in a terminal.
  cliPathControl = isDesktopAppPackage(packageRoot) ? createCliPathControl({ dataDir: paths.dataDir, packageRoot,
    installRoot: windowsInstallRoot(packageRoot) }) : null,
  // What is new in the installed version, and whether the console has said so yet.
  whatsNew = createWhatsNew({ dataDir: paths.dataDir }),
  // Whether this installation's desktop client opens fuli:// links (the console's 「在客户端打开」).
  desktopClientOpens = desktopClientOpensLinks({ packageRoot }),
  // The data format plan (migration-plan.js) the doctor reads; null without a local installation.
  previewDataFormats = null,
  // Reads Codex's hook trust from its app-server (src/agents/codex/hook-trust.js).
  codexHookTrust = createCodexHookTrust(),
  // How much of each client's newest transcript FULI still reads (src/agents/transcript-format-registry.js).
  transcriptFormat = createTranscriptFormatProbe(),
  // Who can open the data directory on Windows (windows-data-acl.js).
  dataDirAcl = windowsDataAcl(),
  // This installation's MCP servers the OS shows running (mcp-process-scan.js).
  scanMcpServers = runningMcpServers,
  now = Date.now,
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
  // Releases are offered from the person's update channel (版本 in settings).
  versionChecker ??= createPackageVersionChecker({ channel: () => configuredSettings().updateChannel });
  const sessionOffers = createSessionOffers({ launcher: agentKits.sessionLauncher, configPath: paths.launcherHostConfigPath,
    readLaunchers: () => configuredSettings().conversationLaunchers, records: sessionClientRecords(paths.dataDir) });
  const newSessions = createNewSessions({ launcher: agentKits.sessionLauncher, presence: createCliPresence() });
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
    // Switching alone would start an empty built-in graph: the Docker graph
    // moves only through the migration, which counts and checks every item.
    if (active.graphRuntimeMode === 'container' && configured.graphRuntimeMode === 'native') {
      throw new TypeError('Move your Docker graph with 「迁移到内置图数据库」 instead of switching the runtime here.');
    }
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
  // The client polls the doctor; the OS process list is read at most once per window.
  let serverScan = null;
  const runningServers = () => {
    if (!serverScan || now() - serverScan.at >= MCP_SCAN_CACHE_MS) {
      serverScan = { at: now(), answer: scanMcpServers(runtimeConfigPath) };
    }
    return serverScan.answer;
  };
  const doctor = createDoctor({ observeClients, previewDataFormats, runningServers,
    npmCopies: () => npmCopyControl?.list().copies ?? [],
    formatOperations: () => readFormatOperations(paths.dataDir), graphStage: () => runtimeBroker.status().stage,
    hookTrust: async () => ({ [CODEX_HOOK_TRUST_CLIENT]: await codexHookTrust() }), transcriptFormat,
    liveProcesses: () => liveMcpProcesses(runtimeConfigPath), awaitingRestart: () => sessionsAwaitingRestart(runtimeConfigPath), latestVersion: () => versionChecker.peek(),
    lastUpdate: () => update.status(),
    dataDirShared: () => dataDirAcl.sharedWith(paths.dataDir),
    // Only a graph that was set up has a mode; a fresh data directory has nothing to move.
    graphRuntime: () => readJson(paths.graphRuntimeStatePath, null)
      ? { mode: activeSettings().graphRuntimeMode, migration: readGraphMigration(paths) } : null,
    portMoves: () => {
      const state = readJson(paths.graphRuntimeStatePath, null);
      return state?.portMoves ? { movedAt: state.startedAt, moves: state.portMoves } : null;
    } });

  // The 诊断包 a person previews and exports (diagnostics-bundle.js); reading
  // settings for it never syncs the launcher's configuration as getSettings does.
  const diagnostics = createDiagnosticsBundle({ paths, doctor: () => doctor.check(), installKind: () => update.kind(),
    settings: () => ({ configured: configuredSettings(), active: activeSettings() }) });
  const logRetention = createLogRetention({ paths });

  const stopCodexFlaPrompts = codexFlaPrompts?.start(agentKits.clientInstaller) ?? (() => {});
  const turnRecords = debugTurnStore(paths.dataDir);
  const modelCapture = createModelCapture({ store: turnRecords });
  return {
    npmCopies: npmCopyControl,
    cliPath: cliPathControl,
    whatsNew,
    desktopClientOpensLinks: desktopClientOpens,
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
    // A new session in a connected client's CLI (new-sessions.js): which can open, and the click that opens one.
    newSessionWays: (clientIds) => newSessions.ways(clientIds),
    openNewSession: (request) => newSessions.open(request),
    connectClient: clientInstaller,
    // Clients the person describes by hand (custom-client-connection.js).
    ...createCustomClients({ installer: agentKits.clientInstaller, store: customClients }),
    resources: () => resourceMonitor.sample(),
    // updateKind: how the console's one-click update installs it (console-update.js).
    versionStatus: async (options) => ({ ...await versionChecker.check(options), updateKind: update.kind() }),
    // The checker's last answer without asking npm (`fuli status`); 'unchecked' before its first.
    cachedVersionStatus: () => versionChecker.peek() ?? { status: 'unchecked' },
    updateStatus: () => update.status(),
    startUpdate: async ({ stopProcesses } = {}) => {
      const version = await versionChecker.check();
      return update.start({ version: version.updateAvailable ? version.latestVersion : null, channel: version.channel, stopProcesses });
    },
    // FULI's 体检 and its repair of what needs no person (doctor.js, doctor-repair.js).
    doctor: () => doctor.check(),
    diagnostics,
    // The one-click move of an older install's Docker graph (graph-migration.js).
    graphMigration: () => readGraphMigration(paths),
    startGraphMigration: () => startGraphMigration(paths, { runtimeMode: () => activeSettings().graphRuntimeMode }),
    // The kept copies of FULI's logs and the person's 「清理旧日志」 (log-retention.js).
    logArchives: () => logRetention.archives(),
    clearLogArchives: () => logRetention.clearArchives(),
    // The #fulidebug turn records the person reads in Settings › 系统 (debug-turns/store.js).
    debugTurns: turnRecords,
    modelCapture,
    repairDoctor: createDoctorRepair({ check: doctor.check, connectClient: clientInstaller, observeClients,
      recordClientsReconnected: (id) => update.recordClientsReconnected(id),
      restrictDataDir: () => dataDirAcl.restrictToOwner(paths.dataDir) }),
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
    close: () => {
      stopCodexFlaPrompts();
      logRetention.close();
      void modelCapture.close();
      return runtimeBroker.close();
    }
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
        topicPromotion: active.topicPromotion,
        updateChannel: active.updateChannel,
        flaSlashMenu: active.flaSlashMenu,
        consoleLanguage: active.consoleLanguage
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

// An installed Windows app's installation root, or null (macOS, a portable tray).
function windowsInstallRoot(packageRoot) {
  if (process.platform !== 'win32') return null;
  try { return readWindowsInstallation(packageRoot)?.installRoot ?? null; } catch { return null; }
}
