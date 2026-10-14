import assert from 'node:assert/strict';
import test from 'node:test';

import { withCodexLifecycleHooks } from '../src/agents/codex/lifecycle-hooks.js';

const context = (nodePath, platform) => ({ nodePath, platform, runtimeConfigPath: 'C:\\Users\\a\\Fuli\\graph-runtime.json',
  codexLifecycleHookPath: 'C:\\pkg\\fuli-context\\src\\agents\\codex\\lifecycle-hook.js' });
const command = (nodePath, platform) =>
  withCodexLifecycleHooks({}, { context: context(nodePath, platform) }).hooks.UserPromptSubmit[0].hooks[0].command;

test('Windows Codex hook commands parse in PowerShell, which Codex uses to run them', () => {
  // A quoted executable followed by arguments is a PowerShell parse error.
  const plain = command('C:\\nvm4w\\nodejs\\node.exe', 'win32');
  assert.ok(plain.startsWith('C:\\nvm4w\\nodejs\\node.exe "C:\\pkg\\'), plain);
  const spaced = command('C:\\Program Files\\nodejs\\node.exe', 'win32');
  assert.ok(spaced.startsWith('& "C:\\Program Files\\nodejs\\node.exe" "C:\\pkg\\'), spaced);
  assert.ok(command('/usr/local/bin/node', 'linux').startsWith("'/usr/local/bin/node' '"));
});
