import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stablePackageRoot } from './stable-package-root.js';
import { readWindowsNativeBundle } from '../native-runtime/windows-assets.js';
import { readWindowsInstallation } from '../desktop/windows-installation-context.js';
import { installedWindowsNodeLauncher } from '../desktop/windows-node-launcher.js';

const DEFAULT_PACKAGE_ROOT = stablePackageRoot(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

export function resolveSetupPaths({
  dataDir = null,
  cwd = process.cwd(),
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  packageRoot = DEFAULT_PACKAGE_ROOT
} = {}) {
  const root = resolve(packageRoot);
  const bundle = platform === 'win32' ? readWindowsNativeBundle(root) : null;
  const installed = bundle ? readWindowsInstallation(root) : null;
  // An installed Windows copy's clients run the stable launcher at its installation
  // root with package-relative scripts: it starts the version installation.json
  // names, so an update or rollback changes no client configuration (rec#11 D-80).
  // Elsewhere, and before an installation has the launcher, this Node runs this package.
  const launcher = installed ? installedWindowsNodeLauncher(installed.installRoot) : null;
  const resolvedDataDir = resolve(cwd, dataDir ?? installed?.dataDir ?? nonEmpty(env.FULI_DATA_DIR)
    ?? bundle?.dataDir ?? defaultDataDir({ platform, env, homeDir }));
  const nativeRuntimeDir = join(resolvedDataDir, 'native-runtime');
  const runtimeConfigDir = join(resolvedDataDir, 'runtime-configs');
  return {
    dataDir: resolvedDataDir,
    // A Windows portable folder is removed by deleting it, not via npm.
    portableRoot: bundle?.bundleRoot ?? null,
    graphEnvPath: join(resolvedDataDir, 'graph-provider.env'),
    graphRuntimeConfigPath: join(resolvedDataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(resolvedDataDir, 'graph-runtime-state.json'),
    adaptiveRuntimeSettingsPath: join(resolvedDataDir, 'adaptive-runtime-settings.json'),
    adaptiveRuntimeStatePath: join(resolvedDataDir, 'adaptive-runtime-state.json'),
    runtimeSettingsPath: join(resolvedDataDir, 'runtime-settings.json'),
    runtimeSettingsBackupDir: join(resolvedDataDir, 'backups', 'settings'),
    modelBackendConfigPath: join(resolvedDataDir, 'model-backends.json'),
    modelSecretStorePath: join(resolvedDataDir, 'model-secrets.json'),
    modelUsageLedgerPath: join(resolvedDataDir, 'model-usage.sqlite'),
    roleWorkPath: join(resolvedDataDir, 'role-work.sqlite'),
    roleSuggestionsPath: join(resolvedDataDir, 'role-suggestions.sqlite'),
    modelTrustPath: join(resolvedDataDir, 'model-trust.sqlite'),
    modelSettingsHistoryPath: join(resolvedDataDir, 'model-settings-history.sqlite'),
    standingAssignmentsPath: join(resolvedDataDir, 'standing-assignments.sqlite'),
    modelEvaluationsPath: join(resolvedDataDir, 'model-evaluations.json'),
    clientLinksPath: join(resolvedDataDir, 'client-links.json'),
    // Derived from FULI's settings and descriptor packs for the shared client components (src/agent-kits/).
    launcherHostConfigPath: join(resolvedDataDir, 'agent-kits', 'launcher.json'),
    installerManifestPath: join(resolvedDataDir, 'agent-kits', 'fuli-installer.json'),
    nativeRuntimeDir,
    nativeRuntimeManifestPath: join(nativeRuntimeDir, 'manifest.json'),
    nativeProcessStatePath: join(nativeRuntimeDir, 'processes.json'),
    nativeNeo4jHome: join(nativeRuntimeDir, 'neo4j-community-5.26.28'),
    nativeProviderVenvPath: join(nativeRuntimeDir, 'provider-venv'),
    nativePersonalDir: join(nativeRuntimeDir, 'personal'),
    nativeWorkspaceDir: join(nativeRuntimeDir, 'workspace'),
    containerGraphConfigProfilePath: join(runtimeConfigDir, 'container.json'),
    nativeGraphConfigProfilePath: join(runtimeConfigDir, 'native.json'),
    externalKnowledgeRegistryPath: join(
      resolvedDataDir,
      'external-knowledge',
      'bindings.json'
    ),
    externalKnowledgeConflictPolicyPath: join(
      resolvedDataDir,
      'external-knowledge',
      'conflict-policies.json'
    ),
    externalKnowledgeConnectorDir: join(
      resolvedDataDir,
      'external-knowledge',
      'connectors'
    ),
    backupDir: join(resolvedDataDir, 'backups', 'agents'),
    agentDirectoryRoot: join(resolvedDataDir, 'agents'),
    graphBackupDir: graphBackupDirectory(resolvedDataDir),
    logPath: join(resolvedDataDir, 'logs', 'runtime.log'),
    serverPath: join(root, 'src', 'server.js'),
    // What client configurations run: the MCP entry and lifecycle hooks name this
    // command and scripts beside mcpServerPath.
    clientNodePath: launcher ?? process.execPath,
    mcpServerPath: launcher ? join('src', 'mcp-server.js') : join(root, 'src', 'mcp-server.js'),
    graphSetupPath: join(root, 'src', 'graphiti', 'setup.js'),
    graphComposePath: join(root, 'compose.graphiti.yml'),
    sessionSkillPath: join(root, 'skills', 'capturing-session-knowledge'),
    projectSkillPath: join(root, 'skills', 'grilling-project'),
    reviewSkillPath: join(root, 'skills', 'flreview'),
    operationSkillPath: join(root, 'skills', 'operating-fuli'),
    sessionCommandSkillPath: join(root, 'skills', 'fuli')
  };
}

// Where a native graph instance's provider and Neo4j console write their output.
export function nativeInstanceLogPaths(instanceDir) {
  return {
    provider: join(instanceDir, 'logs', 'provider.log'),
    database: join(instanceDir, 'logs', 'neo4j-console.log')
  };
}

// Where `fuli graph export` backups of a data directory are kept.
export function graphBackupDirectory(dataDir) {
  return join(dataDir, 'backups', 'graph');
}

function defaultDataDir({ platform, env, homeDir }) {
  if (platform === 'win32') {
    return join(nonEmpty(env.LOCALAPPDATA) ?? join(homeDir, 'AppData', 'Local'), 'Fuli');
  }
  if (platform === 'darwin') {
    return join(homeDir, 'Library', 'Application Support', 'Fuli');
  }
  return join(nonEmpty(env.XDG_DATA_HOME) ?? join(homeDir, '.local', 'share'), 'fuli');
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}
