import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { quoteShellArgument } from '../../cli/shell-argument.js';
import { readJsonFile, writeJsonFileAtomic } from '../../storage/json-file.js';

const TOOLS = new Set(['begin_task_context', 'verify_task_checkpoint']);
const COMMAND_MARKER = '--fuli-lifecycle';
const TOML_HOOK_GROUP = /^\s*\[\[hooks\.([A-Za-z][A-Za-z0-9_]*)]]\s*(?:#.*)?$/;
const TOML_TABLE = /^\s*\[{1,2}([^\]]+)\]{1,2}\s*(?:#.*)?$/;

export function withCodexLifecycleHooks(current, { timeout = 30, context = null } = {}) {
  const clean = withoutCodexLifecycleHooks(current);
  const hooks = { ...(clean.hooks ?? {}) };
  for (const [event, tool, input] of [
    ['UserPromptSubmit', 'begin_task_context', {
      sessionId: '${session_id}', turnId: '${turn_id}',
      projectPath: '${cwd}', taskPrompt: '${prompt}'
    }],
    ['Stop', 'verify_task_checkpoint', { sessionId: '${session_id}' }]
  ]) {
    const handler = event === 'Stop' && context
      ? { type: 'command', command: codexStopCommand(context), timeout }
      : { type: 'mcp_tool', server: 'fuli', tool, input, timeout };
    hooks[event] = [...(hooks[event] ?? []), { hooks: [handler] }];
  }
  return { ...clean, hooks };
}

export function withoutCodexLifecycleHooks(current) {
  if (!current || Array.isArray(current) || typeof current !== 'object') {
    throw new TypeError('Codex hooks config must be an object');
  }
  if (!current.hooks) return current;
  if (Array.isArray(current.hooks) || typeof current.hooks !== 'object') {
    throw new TypeError('Codex hooks must be an object');
  }
  const hooks = {};
  for (const [event, groups] of Object.entries(current.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !Array.isArray(group?.hooks))) {
      throw new TypeError('Codex hook event must contain groups of handlers');
    }
    const remaining = groups.map(group => ({
      ...group,
      hooks: group.hooks.filter(hook => !isManagedCodexHook(hook))
    })).filter(group => group.hooks.length);
    if (remaining.length) hooks[event] = remaining;
  }
  const { hooks: _removed, ...rest } = current;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

export function installCodexLifecycleHooks(agent, {
  readConfig = readJsonFile, writeConfig = writeJsonFileAtomic, context = null
} = {}) {
  if (!agent.hooksPath) return { changed: false };
  const current = readConfig(agent.hooksPath, {});
  const next = withCodexLifecycleHooks(current, { context });
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeConfig(agent.hooksPath, next);
  // Installing never edits the host's trust store or bypasses its review.
  return { changed, trustReviewRequired: changed };
}

export function removeCodexLifecycleHooks(agent, {
  fileExists = existsSync, readConfig = readJsonFile, writeConfig = writeJsonFileAtomic
} = {}) {
  if (!agent.hooksPath || !fileExists(agent.hooksPath)) return { changed: false };
  const current = readConfig(agent.hooksPath, {});
  const next = withoutCodexLifecycleHooks(current);
  const changed = JSON.stringify(current) !== JSON.stringify(next);
  if (changed) writeConfig(agent.hooksPath, next);
  return { changed };
}

export function hasCurrentCodexLifecycleHooks(current, { context = null } = {}) {
  try {
    return JSON.stringify(withCodexLifecycleHooks(current, { context })) === JSON.stringify(current);
  } catch { return false; }
}

export function hasCodexTomlHookDefinitions(source) {
  return String(source).replaceAll('\r\n', '\n').split('\n')
    .some((line) => TOML_HOOK_GROUP.test(line));
}

export function withCodexTomlLifecycleHooks(source, { timeout = 30, context = null } = {}) {
  const clean = withoutCodexTomlLifecycleHooks(source);
  const lines = clean.replaceAll('\r\n', '\n').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const blocks = [
    ...codexTomlHookBlock('UserPromptSubmit', 'begin_task_context', {
      sessionId: '${session_id}',
      turnId: '${turn_id}',
      projectPath: '${cwd}',
      taskPrompt: '${prompt}'
    }, timeout),
    ...(context
      ? codexTomlCommandHookBlock('Stop', codexStopCommand(context), timeout)
      : codexTomlHookBlock('Stop', 'verify_task_checkpoint', {
          sessionId: '${session_id}'
        }, timeout))
  ];
  return `${[...lines, ...(lines.length ? [''] : []), ...blocks].join('\n')}\n`;
}

export function withoutCodexTomlLifecycleHooks(source) {
  const lines = String(source).replaceAll('\r\n', '\n').split('\n');
  const kept = [];
  let removed = false;

  for (let index = 0; index < lines.length;) {
    const group = TOML_HOOK_GROUP.exec(lines[index]);
    if (!group) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }

    const event = group[1];
    let end = index + 1;
    while (end < lines.length) {
      const table = TOML_TABLE.exec(lines[end])?.[1]?.trim();
      if (table && table !== `hooks.${event}.hooks` &&
          table !== `hooks.${event}.hooks.input`) break;
      end += 1;
    }
    const block = lines.slice(index, end);
    const filtered = withoutManagedTomlHookHandlers(block, event);
    if (filtered.removed) removed = true;
    kept.push(...filtered.lines);
    index = end;
  }

  if (!removed) return source;
  while (kept.length && !kept.at(-1).trim()) kept.pop();
  return kept.length ? `${kept.join('\n')}\n` : '';
}

export function hasCurrentCodexTomlLifecycleHooks(source, { context = null } = {}) {
  return normalizeText(withCodexTomlLifecycleHooks(source, { context })) === normalizeText(source);
}

function codexTomlHookBlock(event, tool, input, timeout) {
  return [
    `[[hooks.${event}]]`,
    '',
    `[[hooks.${event}.hooks]]`,
    'type = "mcp_tool"',
    'server = "fuli"',
    `tool = ${JSON.stringify(tool)}`,
    `timeout = ${timeout}`,
    '',
    `[hooks.${event}.hooks.input]`,
    ...Object.entries(input).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
    ''
  ];
}

function codexTomlCommandHookBlock(event, command, timeout) {
  return [
    `[[hooks.${event}]]`,
    '',
    `[[hooks.${event}.hooks]]`,
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
    `timeout = ${timeout}`,
    ''
  ];
}

function isManagedTomlHookBlock(lines) {
  const source = lines.join('\n');
  const tool = /^\s*tool\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m.exec(source)?.[1];
  const managedMcp = /^\s*server\s*=\s*["']fuli["']\s*(?:#.*)?$/m.test(source) &&
    TOOLS.has(tool);
  return managedMcp || (source.includes(COMMAND_MARKER) && source.includes('lifecycle-hook.js'));
}

function withoutManagedTomlHookHandlers(block, event) {
  const handlerTable = `hooks.${event}.hooks`;
  const handlerStarts = [];
  for (let index = 1; index < block.length; index += 1) {
    if (
      /^\s*\[\[/.test(block[index]) &&
      TOML_TABLE.exec(block[index])?.[1]?.trim() === handlerTable
    ) {
      handlerStarts.push(index);
    }
  }
  if (handlerStarts.length === 0) return { lines: block, removed: false };

  const keptHandlers = [];
  let removed = false;
  for (let index = 0; index < handlerStarts.length; index += 1) {
    const start = handlerStarts[index];
    const end = handlerStarts[index + 1] ?? block.length;
    const handler = block.slice(start, end);
    if (isManagedTomlHookBlock(handler)) removed = true;
    else keptHandlers.push(...handler);
  }
  if (!removed) return { lines: block, removed: false };
  if (keptHandlers.length === 0) return { lines: [], removed: true };
  return {
    lines: [...block.slice(0, handlerStarts[0]), ...keptHandlers],
    removed: true
  };
}

function isManagedCodexHook(hook) {
  return hook?.type === 'mcp_tool' && hook.server === 'fuli' && TOOLS.has(hook.tool) ||
    hook?.type === 'command' && typeof hook.command === 'string' &&
      hook.command.includes(COMMAND_MARKER) && hook.command.includes('lifecycle-hook.js');
}

function codexStopCommand(context) {
  const script = context.codexLifecycleHookPath ??
    join(dirname(context.mcpServerPath), 'agents', 'codex', 'lifecycle-hook.js');
  return [
    context.nodePath,
    script,
    COMMAND_MARKER,
    '--runtime-config',
    context.runtimeConfigPath,
    '--event',
    'Stop'
  ].map(value => quoteShellArgument(value, context.platform)).join(' ');
}

function normalizeText(value) {
  return String(value).replaceAll('\r\n', '\n').trim();
}
