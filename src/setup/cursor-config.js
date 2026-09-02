import { existsSync } from 'node:fs';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { withCursorLifecycleHooks, withoutCursorLifecycleHooks } from '../agents/cursor/lifecycle-hooks.js';

export function connectCursor(agent, context, {
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  const current = readConfig(agent.configPath, {});
  assertObject(current, 'Cursor MCP config');

  const currentServers = current.mcpServers ?? {};
  assertObject(currentServers, 'Cursor mcpServers');
  const currentHooks = agent.hooksPath ? readConfig(agent.hooksPath, {}) : null;
  const nextHooks = agent.hooksPath ? withCursorLifecycleHooks(currentHooks, context) : null;

  const next = {
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
  };
  const registrationChanged = JSON.stringify(current) !== JSON.stringify(next);
  if (registrationChanged) writeConfig(agent.configPath, next);
  const hooksChanged = nextHooks && JSON.stringify(currentHooks) !== JSON.stringify(nextHooks);
  if (hooksChanged) writeConfig(agent.hooksPath, nextHooks);

  return { id: agent.id, label: agent.label, status: 'connected',
    ...(agent.hooksPath
      ? { newTaskRequired: registrationChanged || Boolean(hooksChanged) }
      : {}) };
}

export function disconnectCursor(agent, {
  fileExists = existsSync,
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  let hooksChanged = false;
  if (agent.hooksPath && fileExists(agent.hooksPath)) {
    const currentHooks = readConfig(agent.hooksPath, {});
    const nextHooks = withoutCursorLifecycleHooks(currentHooks);
    hooksChanged = JSON.stringify(currentHooks) !== JSON.stringify(nextHooks);
    if (hooksChanged) writeConfig(agent.hooksPath, nextHooks);
  }
  if (!fileExists(agent.configPath)) {
    return { id: agent.id, label: agent.label, status: hooksChanged ? 'disconnected' : 'not_connected' };
  }
  const current = readConfig(agent.configPath, {});
  assertObject(current, 'Cursor MCP config');
  const currentServers = current.mcpServers ?? {};
  assertObject(currentServers, 'Cursor mcpServers');
  if (!Object.hasOwn(currentServers, 'fuli')) {
    return { id: agent.id, label: agent.label, status: hooksChanged ? 'disconnected' : 'not_connected' };
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
