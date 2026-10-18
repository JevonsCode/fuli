import { discoverAgents } from '../setup/agents.js';
import { installAgent } from '../setup/install-agent.js';
import { assertJsonObject } from '../validation/values.js';

export function createClientInstaller({ paths, runtimeConfigPath = paths.graphRuntimeConfigPath,
  discover = discoverAgents, install = installAgent }) {
  let busy = false;
  return async (input) => {
    assertJsonObject(input, 'Client connection');
    if (Object.keys(input).length !== 1 || typeof input.clientId !== 'string') {
      throw new TypeError('Expected only a clientId');
    }
    if (busy) throw new TypeError('A client connection is already being installed');
    const agent = discover().find(({ id }) => id === input.clientId);
    if (!agent?.available || agent.manualOnly) throw new TypeError('Client is unavailable for automatic connection');
    busy = true;
    try {
      const result = await install(agent, {
        defaultToolProfile: 'chat', nodePath: process.execPath, mcpServerPath: paths.mcpServerPath, runtimeConfigPath,
        sessionSkillPath: paths.sessionSkillPath, projectSkillPath: paths.projectSkillPath,
        reviewSkillPath: paths.reviewSkillPath, operationSkillPath: paths.operationSkillPath
      }, paths);
      // Do not expose config/backup paths or raw filesystem diagnostics over HTTP.
      return { id: agent.id, status: result.status, restartRequired: result.status === 'connected' };
    } finally { busy = false; }
  };
}
