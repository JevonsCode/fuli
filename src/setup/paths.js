import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export function resolveSetupPaths({
  dataDir = null,
  cwd = process.cwd(),
  platform = process.platform,
  env = process.env,
  homeDir = homedir(),
  packageRoot = DEFAULT_PACKAGE_ROOT
} = {}) {
  const resolvedDataDir = resolve(cwd, dataDir ?? defaultDataDir({ platform, env, homeDir }));
  const root = resolve(packageRoot);
  const nativeRuntimeDir = join(resolvedDataDir, 'native-runtime');
  const runtimeConfigDir = join(resolvedDataDir, 'runtime-configs');
  return {
    dataDir: resolvedDataDir,
    graphEnvPath: join(resolvedDataDir, 'graph-provider.env'),
    graphRuntimeConfigPath: join(resolvedDataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(resolvedDataDir, 'graph-runtime-state.json'),
    adaptiveRuntimeSettingsPath: join(resolvedDataDir, 'adaptive-runtime-settings.json'),
    adaptiveRuntimeStatePath: join(resolvedDataDir, 'adaptive-runtime-state.json'),
    runtimeSettingsPath: join(resolvedDataDir, 'runtime-settings.json'),
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
    graphBackupDir: join(resolvedDataDir, 'backups', 'graph'),
    logPath: join(resolvedDataDir, 'logs', 'runtime.log'),
    serverPath: join(root, 'src', 'server.js'),
    mcpServerPath: join(root, 'src', 'mcp-server.js'),
    graphSetupPath: join(root, 'src', 'graphiti', 'setup.js'),
    graphComposePath: join(root, 'compose.graphiti.yml'),
    sessionSkillPath: join(root, 'skills', 'capturing-session-knowledge'),
    projectSkillPath: join(root, 'skills', 'grilling-project'),
    reviewSkillPath: join(root, 'skills', 'flreview')
  };
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
