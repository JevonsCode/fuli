import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'gemini',
  detect({ homeDir, env = {}, pathApi, fileExists, commandExists, cwd, includeUnavailable = false }) {
    const directory = configDirectory(env.GEMINI_CLI_HOME, homeDir, { homeDir, pathApi, cwd });
    const configPath = pathApi.join(directory, '.gemini', 'settings.json');
    const available = Boolean(commandExists('gemini') || fileExists(configPath));
    return available || includeUnavailable ? { id: 'gemini', label: 'Gemini CLI', command: 'gemini', configPath, available } : null;
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'other', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args }) })
};
