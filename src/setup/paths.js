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
  return {
    dataDir: resolvedDataDir,
    dbPath: join(resolvedDataDir, 'context.db'),
    graphEnvPath: join(resolvedDataDir, 'graph-provider.env'),
    graphRuntimeConfigPath: join(resolvedDataDir, 'graph-runtime.json'),
    graphRuntimeStatePath: join(resolvedDataDir, 'graph-runtime-state.json'),
    backupDir: join(resolvedDataDir, 'backups', 'agents'),
    logPath: join(resolvedDataDir, 'logs', 'runtime.log'),
    statePath: join(resolvedDataDir, 'runtime.json'),
    serverPath: join(root, 'src', 'server.js'),
    mcpServerPath: join(root, 'src', 'mcp-server.js'),
    graphSetupPath: join(root, 'src', 'graphiti', 'setup.js'),
    graphComposePath: join(root, 'compose.graphiti.yml'),
    sessionSkillPath: join(root, 'skills', 'capturing-session-knowledge'),
    projectSkillPath: join(root, 'skills', 'grilling-project')
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
