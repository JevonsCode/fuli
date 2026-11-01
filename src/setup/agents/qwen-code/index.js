import { configDirectory } from '../config-directory.js';
import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'qwen-code',
  target({ homeDir, env = {}, pathApi, cwd }) {
    const directory = configDirectory(env.QWEN_HOME, pathApi.join(homeDir, '.qwen'), { homeDir, pathApi, cwd });
    return { id: 'qwen-code', label: 'Qwen Code', command: 'qwen', configPath: pathApi.join(directory, 'settings.json') };
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'other', argsOf: (server) => server?.args,
    server: (command, args) => ({ command, args }) })
};
