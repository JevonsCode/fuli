#!/usr/bin/env node
import { pluginLifecycleOutput, runPluginLifecycleCommand } from '../plugin-lifecycle-hook.js';
import { isMainModule } from '../../system/main-module.js';

// The FULI side of the DeepSeek Harness plugin (plugin.js). DSH runs as its
// own source application, `dsh`; its MCP entry (bundle.js) runs as `dsh` too,
// so a hook task and the model's MCP calls share one session namespace.
const DSH = Object.freeze({ id: 'dsh', name: 'DeepSeek Harness', sourceApplication: 'dsh' });

export const dshLifecycleOutput = (...args) => pluginLifecycleOutput(DSH, ...args);
export const runDshLifecycleCommand = (...args) => runPluginLifecycleCommand(DSH, ...args);

// The answer is the process's whole job: it exits once the line is flushed,
// so a detached close never lingers on an open handle.
if (isMainModule(import.meta.url)) {
  await runDshLifecycleCommand(process.argv.slice(2));
  process.stdout.write('', () => process.exit(0));
}
