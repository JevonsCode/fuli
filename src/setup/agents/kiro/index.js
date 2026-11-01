import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'kiro',
  target({ homeDir, env = {}, pathApi, cwd }) {
    const directory = configDirectory(env.KIRO_HOME, pathApi.join(homeDir, '.kiro'), { homeDir, pathApi, cwd });
    return { id: 'kiro', label: 'Kiro', command: 'kiro', configPath: pathApi.join(directory, 'settings', 'mcp.json') };
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'kiro', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args, disabled: false }) })
};
