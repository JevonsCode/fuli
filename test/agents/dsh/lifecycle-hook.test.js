// The FULI side of the DeepSeek Harness plugin: the lifecycle hook the plugin
// starts for a turn's first step and for its completed end. It shares its
// behaviour with OpenCode's (plugin-lifecycle-hook.js, covered there); these
// cases pin what is DSH's own: its source application and entry label.
// Synthetic only: temporary directories and a recording Provider double.
import assert from 'node:assert/strict';
import test from 'node:test';

import { callAgentTool } from '../../../src/agent-tools.js';
import { dshLifecycleOutput, runDshLifecycleCommand } from '../../../src/agents/dsh/lifecycle-hook.js';
import { fixture } from '../../fixtures/capture-project-fixture.js';

const SESSION = 'session-synthetic-dsh';

test('a turn begins its task as `dsh` with the DSH session and message, and the stop checks it as `dsh`', async (t) => {
  const f = await fixture(t);
  const calls = [];
  const output = await dshLifecycleOutput('prompt', { session_id: SESSION, message_id: 'synthetic-message', cwd: f.dirs.novel,
    prompt: 'Outline chapter four.' }, (name, parameters) => {
    calls.push([name, parameters]);
    return callAgentTool(f.app, name, parameters);
  });
  const [[name, entry]] = calls;
  assert.equal(name, 'begin_task_context');
  assert.equal(entry.sourceApplication, 'dsh');
  assert.equal(entry.sourceSessionId, SESSION);
  assert.equal(entry.turnId, 'synthetic-message');
  const token = /"taskContextToken":"(fuli-task-[^"]+)"/.exec(output.context)?.[1];
  assert.equal(f.app.taskContextRegistry.context(token, 'dsh').sessionId, SESSION);

  const stops = [];
  assert.deepEqual(await dshLifecycleOutput('stop', { session_id: SESSION }, (tool, parameters) => {
    stops.push([tool, parameters]);
    return callAgentTool(f.app, tool, parameters);
  }), {});
  assert.deepEqual(stops[0], ['verify_task_checkpoint', { sessionId: SESSION, sourceApplication: 'dsh', sourceSessionId: SESSION }]);
});

test('the entry label names DeepSeek Harness and tells the model the stop closes a hook task', async () => {
  const output = await dshLifecycleOutput('prompt', { session_id: SESSION, cwd: '/synthetic/project', prompt: 'Outline.' },
    async () => ({ taskContextToken: 'fuli-task-synthetic', checkpoint_required: false, checkpoint_guidance: 'reported' }));
  assert.match(output.context, /^Fuli task context \(DeepSeek Harness plugin\)\. Apply effective_preferences\. The Stop hook closes this task;/);
});

test('the process entry fails open with one line and records the failure as DSH\'s', async () => {
  const lines = [];
  const result = await runDshLifecycleCommand(['--event', 'prompt', '--timeout-ms', '2000'], {
    readInput: async () => ({ session_id: SESSION, cwd: '/synthetic/project', prompt: 'x' }),
    resolveRuntimeOptions: () => ({ runtimeConfigPath: null }),
    openApplication: () => { throw new Error('synthetic failure'); },
    write: (line) => lines.push(line)
  });
  assert.equal(result.timedOut, false);
  assert.equal(lines.length, 1);
  assert.match(JSON.parse(lines[0]).context, /^Fuli context is unavailable/);
});
