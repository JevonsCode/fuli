// The source application each client's MCP entry names (the descriptor packs and
// fuli-installer-manifest.json). The clients that say 'other' can't be told
// apart, so nothing about their open sessions can be said.
const SOURCES = Object.freeze({ codex: 'codex', 'claude-code': 'claude_code', cursor: 'cursor', opencode: 'opencode',
  'claude-desktop': 'claude', kiro: 'kiro', antigravity: 'antigravity' });

export const clientSourceApplication = id => SOURCES[id] ?? null;
