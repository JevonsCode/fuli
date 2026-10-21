import { existsSync } from 'node:fs';

import { installedToolProfile } from './installed-tool-profile.js';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import { hasCurrentCursorLifecycleHooks, withCursorLifecycleHooks, withoutCursorLifecycleHooks } from '../agents/cursor/lifecycle-hooks.js';
import { assertJsonObject } from '../validation/values.js';
import { renderMcpEntry } from './agents/mcp-entry-template.js';
import { jsonRegistration } from './agents/registration.js';

// The 'cursor-hooks' config writer: the MCP entry in mcp.json and lifecycle hooks in hooks.json.
export function connectCursor(pack, agent, context, {
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  const current = readConfig(agent.configPath, {});
  assertJsonObject(current, 'Cursor MCP config');

  const currentServers = current.mcpServers ?? {};
  assertJsonObject(currentServers, 'Cursor mcpServers');
  const currentHooks = agent.hooksPath ? readConfig(agent.hooksPath, {}) : null;
  const nextHooks = agent.hooksPath ? withCursorLifecycleHooks(currentHooks, context, pack.lifecycleHooks) : null;

  const installedArgs = currentServers.fuli?.args;
  const next = {
    ...current,
    mcpServers: {
      ...currentServers,
      fuli: fuliServer(pack, context, installedArgs,
        Boolean(context.defaultToolProfile || context.toolProfile || installedArgs?.includes('--tool-profile')))
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

export function cursorStatus(pack, agent, context, readers) {
  return { registration: jsonRegistration(agent, readers, (server) =>
    fuliServer(pack, context, server?.args, Boolean(server?.args?.includes('--tool-profile')))),
  ...(agent.hooksPath ? { lifecycleHooks: hasCurrentCursorLifecycleHooks(readers.readJson(agent.hooksPath), context, pack.lifecycleHooks) } : {}) };
}

// Cursor names a tool profile only when one is asked for or already installed.
function fuliServer(pack, context, installedArgs, withProfile) {
  return renderMcpEntry(pack.mcpServer, { nodePath: context.nodePath, mcpServerPath: context.mcpServerPath,
    runtimeConfigPath: context.runtimeConfigPath,
    toolProfileArgs: withProfile ? ['--tool-profile', installedToolProfile(installedArgs, context.toolProfile)] : [] });
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
  assertJsonObject(current, 'Cursor MCP config');
  const currentServers = current.mcpServers ?? {};
  assertJsonObject(currentServers, 'Cursor mcpServers');
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
