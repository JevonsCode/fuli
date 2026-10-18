import { connectClaudeCode, disconnectClaudeCode } from '../../claude-code-config.js';
import { adaptAgentForReviewSkill } from '../../review-skill-adapters.js';
import { hasCurrentClaudeCodeHooks } from '../../claude-code-config.js';
import { jsonRegistration } from '../registration.js';

export const adapter = {
  id: 'claude-code',
  detect({ env, homeDir, pathApi, fileExists, commandExists }) {
    const skillName = 'capturing-session-knowledge';
    const projectSkillName = 'grilling-project';
    const operationSkillName = 'operating-fuli';
    const claudeHome = pathApi.join(homeDir, '.claude');
    return adaptAgentForReviewSkill({
      id: 'claude-code',
      label: 'Claude Code',
      command: 'claude',
      configPath: pathApi.join(homeDir, '.claude.json'),
      settingsPath: pathApi.join(claudeHome, 'settings.json'),
      skillPath: pathApi.join(claudeHome, 'skills', skillName),
      projectSkillPath: pathApi.join(claudeHome, 'skills', projectSkillName),
      operationSkillPath: pathApi.join(claudeHome, 'skills', operationSkillName),
      available: Boolean(
        commandExists('claude') ||
        fileExists(pathApi.join(homeDir, '.claude.json')) ||
        fileExists(claudeHome)
      )
    }, { homeDir, pathApi });
  },
  connect(agent, context, dependencies = {}) { return (dependencies.connectClaudeCodeConfig ?? connectClaudeCode)(agent, context); },
  disconnect(agent, dependencies = {}) { return (dependencies.disconnectClaudeCodeConfig ?? disconnectClaudeCode)(agent); },
  status(agent, context, readers) {
    return { registration: jsonRegistration(agent, context, readers, { source: 'claude_code', profile: true }),
      lifecycleHooks: hasCurrentClaudeCodeHooks(readers.readJson(agent.settingsPath), { ...context, hookTimeoutSec: context.hookTimeoutSec ?? 30 }) };
  }
};
