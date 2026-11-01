import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'gemini',
  target({ homeDir, env = {}, pathApi, cwd }) {
    const directory = configDirectory(env.GEMINI_CLI_HOME, homeDir, { homeDir, pathApi, cwd });
    return { id: 'gemini', label: 'Gemini CLI', command: 'gemini', configPath: pathApi.join(directory, '.gemini', 'settings.json') };
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'other', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args }) })
};
