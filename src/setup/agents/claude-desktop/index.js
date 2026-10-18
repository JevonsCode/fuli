import { connectClaudeDesktop, disconnectClaudeDesktop } from '../../claude-desktop-config.js';
import { jsonRegistration } from '../registration.js';
function detect({ platform, env, homeDir, pathApi, fileExists }) {
  const appData = platform === 'win32' ? nonEmpty(env.APPDATA)
    : platform === 'darwin' ? pathApi.join(homeDir, 'Library', 'Application Support') : null;
  if (!appData) return null;
  const configDir = pathApi.join(appData, 'Claude');
  return {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    configPath: pathApi.join(configDir, 'claude_desktop_config.json'),
    available: Boolean(fileExists(configDir))
  };
}

function nonEmpty(value) { return typeof value === 'string' && value.trim() ? value : null; }
export const adapter = {
 id: 'claude-desktop', detect,
 connect(agent, context, dependencies = {}) { return (dependencies.connectClaudeDesktopConfig ?? connectClaudeDesktop)(agent, context); },
 disconnect(agent, dependencies = {}) { return (dependencies.disconnectClaudeDesktopConfig ?? disconnectClaudeDesktop)(agent); },
 status(agent, context, readers) { return { registration: jsonRegistration(agent, context, readers, { source: 'claude', profile: true }) }; }
};
