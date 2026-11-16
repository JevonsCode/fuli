import { dirname, join } from 'node:path';
import { quoteShellArgument } from '../../cli/shell-argument.js';

// A snippet to merge, never a replacement for the person's other hooks.
export function chengxiaobangHookConfig({ nodePath, mcpServerPath, runtimeConfigPath }) {
  const command = [nodePath, join(dirname(mcpServerPath), 'agents', 'chengxiaobang', 'lifecycle-hook.js'),
    '--runtime-config', runtimeConfigPath].map(value => quoteShellArgument(value)).join(' ');
  return { enabled: true, hooks: ['UserPromptSubmit', 'Stop'].map(event => ({
    id: `fuli-${event}`, event, command, timeoutSeconds: 20, enabled: true
  })) };
}
