import { existsSync } from 'node:fs';

import {
  readJsonFile,
  writeJsonFileAtomic
} from '../storage/json-file.js';

const FULI_SERVER = 'fuli';
const MANAGED_HOOK_TOOLS = new Set([
  'begin_task_context',
  'verify_task_checkpoint'
]);

export function connectClaudeCode(agent, context, {
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  const current = readConfig(agent.configPath, {});
  const settings = readConfig(agent.settingsPath, {});
  assertObject(current, 'Claude Code config');
  assertObject(settings, 'Claude Code settings');
  assertObject(current.mcpServers ?? {}, 'Claude Code mcpServers');
  assertHookSettings(settings.hooks ?? {});

  const next = {
    ...current,
    mcpServers: {
      ...(current.mcpServers ?? {}),
      [FULI_SERVER]: {
        type: 'stdio',
        command: context.nodePath,
        args: [
          context.mcpServerPath,
          '--runtime-config',
          context.runtimeConfigPath
        ],
        alwaysLoad: true
      }
    }
  };
  const nextSettings = withManagedHooks(settings);
  const registrationChanged = !sameJson(current, next);
  const hooksChanged = !sameJson(settings, nextSettings);
  if (registrationChanged) writeConfig(agent.configPath, next);
  if (hooksChanged) writeConfig(agent.settingsPath, nextSettings);

  return {
    id: agent.id,
    label: agent.label,
    status: 'connected',
    newTaskRequired: registrationChanged || hooksChanged
  };
}

export function disconnectClaudeCode(agent, {
  fileExists = existsSync,
  readConfig = readJsonFile,
  writeConfig = writeJsonFileAtomic
} = {}) {
  let changed = false;
  if (fileExists(agent.configPath)) {
    const current = readConfig(agent.configPath, {});
    assertObject(current, 'Claude Code config');
    assertObject(current.mcpServers ?? {}, 'Claude Code mcpServers');
    if (Object.hasOwn(current.mcpServers ?? {}, FULI_SERVER)) {
      const { [FULI_SERVER]: _removed, ...remainingServers } =
        current.mcpServers;
      writeConfig(agent.configPath, {
        ...current,
        mcpServers: remainingServers
      });
      changed = true;
    }
  }

  if (agent.settingsPath && fileExists(agent.settingsPath)) {
    const settings = readConfig(agent.settingsPath, {});
    assertObject(settings, 'Claude Code settings');
    assertHookSettings(settings.hooks ?? {});
    const nextSettings = withoutManagedHooks(settings);
    if (!sameJson(settings, nextSettings)) {
      writeConfig(agent.settingsPath, nextSettings);
      changed = true;
    }
  }

  return {
    id: agent.id,
    label: agent.label,
    status: changed ? 'disconnected' : 'not_connected'
  };
}

export function hasCurrentClaudeCodeHooks(settings) {
  try {
    assertObject(settings, 'Claude Code settings');
    assertHookSettings(settings.hooks ?? {});
  } catch {
    return false;
  }
  return [
    ['UserPromptSubmit', 'begin_task_context'],
    ['Stop', 'verify_task_checkpoint']
  ].every(([event, tool]) => (
    (settings.hooks?.[event] ?? []).some((group) =>
      group.hooks.some((hook) => isManagedHook(hook, tool))
    )
  ));
}

function withManagedHooks(settings) {
  const clean = withoutManagedHooks(settings);
  const hooks = { ...(clean.hooks ?? {}) };
  hooks.UserPromptSubmit = [
    ...(hooks.UserPromptSubmit ?? []),
    managedHookGroup('begin_task_context', {
      sessionId: '${session_id}',
      projectPath: '${cwd}'
    }, 'Loading Fuli task context')
  ];
  hooks.Stop = [
    ...(hooks.Stop ?? []),
    managedHookGroup(
      'verify_task_checkpoint',
      { sessionId: '${session_id}' },
      'Checking Fuli task checkpoint'
    )
  ];
  return { ...clean, hooks };
}

function withoutManagedHooks(settings) {
  if (!settings.hooks) return settings;
  const hooks = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const remainingGroups = groups
      .map((group) => ({
        ...group,
        hooks: group.hooks.filter((hook) => !isManagedHook(hook))
      }))
      .filter((group) => group.hooks.length > 0);
    if (remainingGroups.length) hooks[event] = remainingGroups;
  }
  if (Object.keys(hooks).length === 0) {
    const { hooks: _removed, ...withoutHooks } = settings;
    return withoutHooks;
  }
  return { ...settings, hooks };
}

function managedHookGroup(tool, input, statusMessage) {
  return {
    hooks: [{
      type: 'mcp_tool',
      server: FULI_SERVER,
      tool,
      input,
      timeout: 30,
      statusMessage
    }]
  };
}

function isManagedHook(hook, tool = null) {
  return hook?.type === 'mcp_tool'
    && hook.server === FULI_SERVER
    && MANAGED_HOOK_TOOLS.has(hook.tool)
    && (tool === null || hook.tool === tool);
}

function assertHookSettings(value) {
  assertObject(value, 'Claude Code hooks');
  for (const [event, groups] of Object.entries(value)) {
    if (!Array.isArray(groups)) {
      throw new TypeError(`Claude Code hook event ${event} must be an array`);
    }
    for (const group of groups) {
      assertObject(group, `Claude Code ${event} hook group`);
      if (!Array.isArray(group.hooks)) {
        throw new TypeError(`Claude Code ${event} hook group must contain hooks`);
      }
    }
  }
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
