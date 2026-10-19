// A bounded Claude Code judgment run: no custom settings, hooks, MCP servers or tools.
export const judgmentClient = Object.freeze({
  args({ quality }) {
    return ['-p', '--output-format', 'stream-json', '--verbose', '--safe-mode',
      '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--setting-sources', '', '--no-session-persistence', '--permission-mode', 'dontAsk',
      '--effort', quality === 'economy' ? 'low' : quality === 'balanced' ? 'medium' : 'high'];
  },
});
