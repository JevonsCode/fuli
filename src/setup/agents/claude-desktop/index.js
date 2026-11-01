import { connectClaudeDesktop, disconnectClaudeDesktop } from '../../claude-desktop-config.js';
// Claude Desktop keeps its configuration under the per-user application data
// folder on macOS and Windows; it has no Linux build.
function target({ platform, env, homeDir, pathApi }) {
  const appData = platform === 'win32' ? nonEmpty(env.APPDATA)
    : platform === 'darwin' ? pathApi.join(homeDir, 'Library', 'Application Support') : null;
  if (!appData) return null;
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: pathApi.join(appData, 'Claude', 'claude_desktop_config.json')
  };
}

function nonEmpty(value) { return typeof value === 'string' && value.trim() ? value : null; }
export const adapter = {
 id: 'claude-desktop', target,
 connect(agent, context, dependencies = {}) { return (dependencies.connectClaudeDesktopConfig ?? connectClaudeDesktop)(agent, context); },
 disconnect(agent, dependencies = {}) { return (dependencies.disconnectClaudeDesktopConfig ?? disconnectClaudeDesktop)(agent); }
};
