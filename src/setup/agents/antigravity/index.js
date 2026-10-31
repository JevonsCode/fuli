import { jsonMcpPort } from '../json-mcp.js';

// Google Antigravity (rec#11 D-77): the desktop app and its `agy` CLI read one
// MCP file, ~/.gemini/config/mcp_config.json, beside their own state folders
// (~/.gemini/antigravity, ~/.gemini/antigravity-cli). No hooks are known, so
// FULI connects MCP only.
export const adapter = {
  id: 'antigravity',
  detect({ homeDir, pathApi, fileExists, commandExists, includeUnavailable = false }) {
    const gemini = pathApi.join(homeDir, '.gemini');
    const configPath = pathApi.join(gemini, 'config', 'mcp_config.json');
    const available = Boolean(commandExists('agy') || fileExists(configPath)
      || fileExists(pathApi.join(gemini, 'antigravity')) || fileExists(pathApi.join(gemini, 'antigravity-cli')));
    return available || includeUnavailable
      ? { id: 'antigravity', label: 'Antigravity', command: 'agy', configPath, available } : null;
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'antigravity',
    argsOf: (server) => server?.args, server: (command, args) => ({ command, args }) })
};
