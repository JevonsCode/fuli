import { dirname, join } from 'node:path';
import { quoteShellArgument } from '../../cli/shell-argument.js';

export const CLAUDE_LIFECYCLE_MARKER = '--fuli-claude-lifecycle';

export function claudeLifecycleCommand(context, event, timeoutSec) {
  const script = context.claudeLifecycleHookPath ??
    join(dirname(context.mcpServerPath), 'agents', 'claude-code', 'lifecycle-hook.js');
  return [
    context.nodePath, script, CLAUDE_LIFECYCLE_MARKER,
    '--runtime-config', context.runtimeConfigPath, '--event', event,
    '--timeout-ms', String(Math.max(100, timeoutSec * 1000 - 2000))
  ].map(value => quoteShellArgument(value, context.platform)).join(' ');
}

export function isClaudeLifecycleCommand(hook) {
  return hook?.type === 'command' && typeof hook.command === 'string' &&
    hook.command.includes(CLAUDE_LIFECYCLE_MARKER) &&
    hook.command.includes('lifecycle-hook.js');
}
