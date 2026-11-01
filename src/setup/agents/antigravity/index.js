import { jsonMcpPort } from '../json-mcp.js';

// Google Antigravity (rec#11 D-80): the desktop app and its `agy` CLI read one
// MCP file, ~/.gemini/config/mcp_config.json, beside their own state folders
// (~/.gemini/antigravity, ~/.gemini/antigravity-cli). No hooks are known, so
// FULI connects MCP only.
export const adapter = {
  id: 'antigravity',
  target({ homeDir, pathApi }) {
    return { id: 'antigravity', label: 'Antigravity', command: 'agy',
      configPath: pathApi.join(homeDir, '.gemini', 'config', 'mcp_config.json') };
  },
  ...jsonMcpPort({ obsoleteKeys: ['url', 'httpUrl', 'headers', 'type'], source: 'antigravity',
    argsOf: (server) => server?.args, server: (command, args) => ({ command, args }) })
};
