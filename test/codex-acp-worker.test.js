import assert from 'node:assert/strict';
import { isAbsolute, join } from 'node:path';
import test from 'node:test';
import { createCodexAcpWorkerAdapter } from '../src/agents/codex/acp-worker.js';

const descriptor = { runId: 'synthetic-run', personalProjectId: 'synthetic-project',
  capability: 'synthetic-capability-never-in-prompt-1234', projectPath: process.cwd(), taskPrompt: 'Bounded synthetic worker task.',
  toolNames: ['get_collaboration_preferences', 'checkpoint_task_knowledge'] };
const selection = { target_application: 'codex', provider: 'openai', model: 'gpt-6.1-sol',
  model_strategy: { mode: 'deep', reasoning_effort: 'max', capability_hints: [] } };

function fixture(authentication = 'account') {
  const calls = [];
  const handle = { authentication,
    newSession: async input => { calls.push({ kind: 'session', input }); return { sessionId: 'child-session' }; },
    configureModel: async input => { calls.push({ kind: 'configure', input }); return input; },
    promptOnce: async input => { calls.push({ kind: 'prompt', input }); return { sessionId: 'child-session', text: 'Synthetic result.', stopReason: 'end_turn' }; },
    close: async () => { calls.push({ kind: 'close' }); } };
  const paths = { adapterPath: join(process.cwd(), 'synthetic-adapter.cjs'), codexPath: process.execPath,
    codexHome: join(process.cwd(), 'synthetic-isolated-home'), runtimeConfigPath: join(process.cwd(), 'synthetic-runtime.json') };
  return { calls, paths, handle, adapter: createCodexAcpWorkerAdapter({ ...paths,
    startProcess: async input => { calls.push({ kind: 'start', input }); return handle; } }) };
}

test('Codex worker composes only the restricted stdio MCP with host descriptor and exact model/effort', async () => {
  const { adapter, calls, paths } = fixture();
  const controller = new AbortController();
  const child = await adapter.start({ descriptor, selection, signal: controller.signal });
  assert.deepEqual(calls[0].input, { adapterPath: paths.adapterPath, codexPath: paths.codexPath,
    codexHome: paths.codexHome, cwd: descriptor.projectPath, signal: controller.signal });
  assert.deepEqual(await child.newSession(), { sessionId: 'child-session' });
  const server = calls[1].input.mcpServers[0];
  assert.equal(server.name, 'fuli_worker');
  assert.equal(server.command, process.execPath);
  assert.equal(isAbsolute(server.args[0]), true);
  assert.match(server.args[0], /mcp-server\.js$/);
  assert.deepEqual(server.args.slice(1), ['--worker', '--runtime-config', paths.runtimeConfigPath]);
  assert.deepEqual(server.env, [{ name: 'FULI_WORKER_DESCRIPTOR', value: JSON.stringify(descriptor) }]);
  await child.configure();
  assert.deepEqual(calls[2].input, { modelId: 'gpt-6.1-sol', reasoningEffort: 'max' });
  const input = { text: 'Synthetic prompt.', signal: controller.signal };
  const reply = await child.promptOnce(input);
  assert.equal(calls[3].input, input);
  assert.equal(reply.stopReason, 'end_turn');
  assert.equal(Object.hasOwn(reply, 'actual_model'), false);
  await child.close();
  assert.equal(calls.at(-1).kind, 'close');
});

test('missing native authentication is a blocked bootstrap and closes the owned adapter', async () => {
  for (const kind of ['none', 'unknown']) {
    const { adapter, calls } = fixture(kind);
    await assert.rejects(adapter.start({ descriptor, selection }), { code: 'worker_authentication_required' });
    assert.deepEqual(calls.map(value => value.kind), ['start', 'close']);
  }
});

test('default effort and foreign client mapping cannot launch or silently choose a model', async () => {
  for (const change of [{ model_strategy: { mode: 'deep', reasoning_effort: 'default' } }, { target_application: 'other' }]) {
    const { adapter, calls } = fixture();
    await assert.rejects(adapter.start({ descriptor, selection: { ...selection, ...change } }),
      { code: 'worker_model_strategy_unmapped' });
    assert.equal(calls.length, 0);
  }
});

test('Codex transport errors become bounded common worker errors without raw diagnostics', async () => {
  for (const [method, sourceCode, targetCode] of [
    ['newSession', 'acp_directory_untrusted', 'worker_workspace_untrusted'],
    ['configureModel', 'acp_model_mismatch', 'worker_model_mismatch'],
    ['promptOnce', 'acp_protocol_error', 'worker_transport_failed'],
    ['close', 'acp_cleanup_incomplete', 'worker_cleanup_incomplete']
  ]) {
    const f = fixture();
    f.handle[method] = async () => { throw Object.assign(new Error(descriptor.capability), { code: sourceCode }); };
    const child = await f.adapter.start({ descriptor, selection });
    const invoke = method === 'configureModel' ? child.configure : method === 'promptOnce'
      ? () => child.promptOnce({ text: 'Synthetic input.' }) : child[method];
    await assert.rejects(invoke(), error => {
      assert.equal(error.code, targetCode);
      assert.equal((error.stack + JSON.stringify(error)).includes(descriptor.capability), false);
      return true;
    });
  }
});
