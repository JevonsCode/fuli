#!/usr/bin/env node
import { runPluginLifecycleCommand } from '../plugin-lifecycle-hook.js';
import { readHookInput } from '../lifecycle-input.js';
import { isMainModule } from '../../system/main-module.js';

// Chengxiaobang command hooks use a top-level additionalContext, not Claude
// Code's hookSpecificOutput. Its MCP connection uses the generic `other`
// source too; keep the real host session id so MCP and hooks share a task.
const CLIENT = Object.freeze({ id: 'chengxiaobang', name: 'Chengxiaobang', sourceApplication: 'other' });
const EVENTS = Object.freeze({ UserPromptSubmit: 'prompt', Stop: 'stop' });

export async function runChengxiaobangLifecycleCommand(args, dependencies = {}) {
  const input = await (dependencies.readInput ?? readHookInput)();
  const event = EVENTS[input?.hook_event_name];
  const write = dependencies.write ?? (value => process.stdout.write(value));
  // Child agents inherit the parent's session id. Their Stop must never
  // close the parent's task. SessionStart is unnecessary: every prompt loads.
  if (!event || input.subagent === true) {
    write('{}\n');
    return;
  }
  return runPluginLifecycleCommand(CLIENT, [...args, '--event', event], {
    ...dependencies,
    readInput: async () => ({ ...input, message_id: input.run_id }),
    write: line => {
      const output = JSON.parse(line);
      write(`${JSON.stringify(output.context ? { additionalContext: output.context } : {})}\n`);
    }
  });
}

if (isMainModule(import.meta.url)) {
  await runChengxiaobangLifecycleCommand(process.argv.slice(2));
  process.stdout.write('', () => process.exit(0));
}
