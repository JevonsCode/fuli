import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'qwen-code',
  detect({ homeDir, env = {}, pathApi, fileExists, commandExists, cwd, includeUnavailable = false }) {
    const directory = configDirectory(env.QWEN_HOME, pathApi.join(homeDir, '.qwen'), { homeDir, pathApi, cwd });
    const configPath = pathApi.join(directory, 'settings.json');
    const available = Boolean(commandExists('qwen') || fileExists(configPath));
    return available || includeUnavailable ? { id: 'qwen-code', label: 'Qwen Code', command: 'qwen', configPath, available } : null;
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'other', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args }) })
};
