import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'kiro',
  detect({ homeDir, env = {}, pathApi, fileExists, commandExists, cwd, includeUnavailable = false }) {
    const directory = configDirectory(env.KIRO_HOME, pathApi.join(homeDir, '.kiro'), { homeDir, pathApi, cwd });
    const configPath = pathApi.join(directory, 'settings', 'mcp.json');
    const available = Boolean(commandExists('kiro') || commandExists('kiro-cli') || fileExists(configPath));
    return available || includeUnavailable ? { id: 'kiro', label: 'Kiro', command: 'kiro', configPath, available } : null;
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'kiro', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args, disabled: false }) })
};
