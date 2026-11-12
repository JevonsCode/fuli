#!/usr/bin/env node
import { pluginLifecycleOutput, runPluginLifecycleCommand, runPluginLifecycleHook } from '../plugin-lifecycle-hook.js';
import { isMainModule } from '../../system/main-module.js';

// The FULI side of the OpenCode V2 plugin (plugin.js). OpenCode's own source
// application (rec#11 D-64); its MCP entry runs as `opencode` too, so a hook
// task and the model's MCP calls share one session namespace that no other
// `other` client shares.
const OPENCODE = Object.freeze({ id: 'opencode', name: 'OpenCode', sourceApplication: 'opencode' });

export const openCodeLifecycleOutput = (...args) => pluginLifecycleOutput(OPENCODE, ...args);
export const runOpenCodeLifecycleHook = (...args) => runPluginLifecycleHook(OPENCODE, ...args);
export const runOpenCodeLifecycleCommand = (...args) => runPluginLifecycleCommand(OPENCODE, ...args);

// The answer is the process's whole job: it exits once the line is flushed,
// so a detached close never lingers on an open handle.
if (isMainModule(import.meta.url)) {
  await runOpenCodeLifecycleCommand(process.argv.slice(2));
  process.stdout.write('', () => process.exit(0));
}
