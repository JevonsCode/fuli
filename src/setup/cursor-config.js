import { existsSync } from 'node:fs';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

export function connectCursor(agent, context, {
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  const current = readConfig(agent.configPath, {});
  assertObject(current, 'Cursor MCP config');

  const currentServers = current.mcpServers ?? {};
  assertObject(currentServers, 'Cursor mcpServers');

  writeConfig(agent.configPath, {
    ...current,
    mcpServers: {
      ...currentServers,
      fuli: {
        command: context.nodePath,
        args: [
          context.mcpServerPath,
          '--runtime-config',
          context.runtimeConfigPath,
          '--source-application',
          'cursor'
        ]
      }
    }
  });

  return { id: agent.id, label: agent.label, status: 'connected' };
}

export function disconnectCursor(agent, {
  fileExists = existsSync,
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  if (!fileExists(agent.configPath)) {
    return { id: agent.id, label: agent.label, status: 'not_connected' };
  }
  const current = readConfig(agent.configPath, {});
  assertObject(current, 'Cursor MCP config');
  const currentServers = current.mcpServers ?? {};
  assertObject(currentServers, 'Cursor mcpServers');
  if (!Object.hasOwn(currentServers, 'fuli')) {
    return { id: agent.id, label: agent.label, status: 'not_connected' };
  }

  const { fuli: _removed, ...remainingServers } = currentServers;
  writeConfig(agent.configPath, {
    ...current,
    mcpServers: remainingServers
  });
  return { id: agent.id, label: agent.label, status: 'disconnected' };
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}
