import { dirname, join } from 'node:path';
import { quoteShellArgument } from '../../cli/shell-argument.js';

const MARKER = '--fuli-lifecycle';

export function withCursorLifecycleHooks(current, context) {
  const clean = withoutCursorLifecycleHooks(current);
  const script = context.cursorLifecycleHookPath
    ?? join(dirname(context.mcpServerPath), 'agents', 'cursor', 'lifecycle-hook.js');
  const command = [context.nodePath, script, MARKER, '--runtime-config', context.runtimeConfigPath]
    .map(value => quoteShellArgument(value, context.platform)).join(' ');
  const hooks = { ...(clean.hooks ?? {}) };
  for (const event of ['sessionStart', 'beforeSubmitPrompt', 'stop']) {
    hooks[event] = [...(hooks[event] ?? []), {
      command: `${command} --event ${event}`, timeout: 30,
      ...(event === 'stop' ? { loop_limit: 2 } : {})
    }];
  }
  return { ...clean, version: 1, hooks };
}

export function withoutCursorLifecycleHooks(current) {
  if (!current || Array.isArray(current) || typeof current !== 'object') {
    throw new TypeError('Cursor hooks config must be an object');
  }
  if (current.version !== undefined && current.version !== 1) {
    throw new TypeError('Unsupported Cursor hooks config version');
  }
  if (!current.hooks) return current;
  if (Array.isArray(current.hooks) || typeof current.hooks !== 'object') {
    throw new TypeError('Cursor hooks must be an object');
  }
  const hooks = {};
  for (const [event, handlers] of Object.entries(current.hooks)) {
    if (!Array.isArray(handlers)) throw new TypeError('Cursor hook event must be an array');
    const remaining = handlers.filter(hook => !(
      typeof hook?.command === 'string' && hook.command.includes(MARKER)
      && hook.command.includes('lifecycle-hook.js')
    ));
    if (remaining.length) hooks[event] = remaining;
  }
  const { hooks: _removed, ...rest } = current;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

export function hasCurrentCursorLifecycleHooks(current, context) {
  try {
    return JSON.stringify(withCursorLifecycleHooks(current, context)) === JSON.stringify(current);
  } catch { return false; }
}
