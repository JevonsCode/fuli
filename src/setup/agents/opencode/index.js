import { jsonMcpPort } from '../json-mcp.js';

export const adapter = {
  id: 'opencode',
  detect({ homeDir, env, pathApi, fileExists, commandExists, includeUnavailable = false }) {
    const directory = pathApi.join(env.XDG_CONFIG_HOME || pathApi.join(homeDir, '.config'), 'opencode');
    const json = pathApi.join(directory, 'opencode.json');
    const jsonc = pathApi.join(directory, 'opencode.jsonc');
    const configPath = fileExists(jsonc) ? jsonc : json;
    const available = Boolean(commandExists('opencode') || fileExists(configPath));
    // Layered global files or explicit environment overrides can shadow this edit.
    // Offer the documented manual configuration instead of claiming a connection.
    const manualOnly = Boolean((fileExists(json) && fileExists(jsonc)) || env.OPENCODE_CONFIG || env.OPENCODE_CONFIG_CONTENT || env.OPENCODE_CONFIG_DIR);
    return available || includeUnavailable ? { id: 'opencode', label: 'OpenCode', command: 'opencode', configPath, available,
      ...(manualOnly ? { manualOnly: true, manualUrl: 'https://opencode.ai/docs/config/' } : {}) } : null;
  },
  ...jsonMcpPort({ key: 'mcp', jsonc: true, obsoleteKeys: ['url', 'oauth', 'headers'], argsOf: (server) => server?.command,
    server: (command, args) => ({ type: 'local', command: [command, ...args], enabled: true }) })
};
