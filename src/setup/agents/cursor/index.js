import { connectCursor, disconnectCursor } from '../../cursor-config.js';
import { adaptAgentForReviewSkill } from '../../review-skill-adapters.js';
import { hasCurrentCursorLifecycleHooks } from '../../../agents/cursor/lifecycle-hooks.js';
import { jsonRegistration } from '../registration.js';

export const adapter = {
  id: 'cursor',
  detect({ env, homeDir, pathApi, fileExists, commandExists }) {
    const skillName = 'capturing-session-knowledge';
    const projectSkillName = 'grilling-project';
    const operationSkillName = 'operating-fuli';
    const cursorHome = pathApi.join(homeDir, '.cursor');
    return adaptAgentForReviewSkill({
      id: 'cursor',
      label: 'Cursor',
      command: 'cursor',
      configPath: pathApi.join(cursorHome, 'mcp.json'),
      hooksPath: pathApi.join(cursorHome, 'hooks.json'),
      skillPath: pathApi.join(cursorHome, 'skills', skillName),
      projectSkillPath: pathApi.join(cursorHome, 'skills', projectSkillName),
      operationSkillPath: pathApi.join(cursorHome, 'skills', operationSkillName),
      available: Boolean(
        commandExists('cursor') ||
        fileExists(pathApi.join(cursorHome, 'mcp.json')) ||
        fileExists(cursorHome)
      )
    }, { homeDir, pathApi });
  },
  connect(agent, context, dependencies = {}) { return (dependencies.connectCursorConfig ?? connectCursor)(agent, context); },
  disconnect(agent, dependencies = {}) { return (dependencies.disconnectJsonConfig ?? disconnectCursor)(agent); },
  status(agent, context, readers) {
    return { registration: jsonRegistration(agent, context, readers, { source: 'cursor', optionalProfile: true }),
      ...(agent.hooksPath ? { lifecycleHooks: hasCurrentCursorLifecycleHooks(readers.readJson(agent.hooksPath), context) } : {}) };
  }
};
