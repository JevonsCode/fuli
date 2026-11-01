import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../src/mcp/create-mcp-server.js';
import { nativeMcpRequestContextResolver } from '../src/agents/native-mcp-context.js';

const a = '019fc6ed-02a5-7832-8821-68e3b03e7cef';
const b = '019fc6ed-02a5-7832-8821-68e3b03e7ced';
const execution = '019fc6ed-02a5-7832-8821-68e3b03e7cee';
const metadata = threadId => ({ threadId, sessionId: execution, windowId: 'native-window-1' });

async function invoke(options, metas) {
  const received = [];
  const app = { getCollaborationPreferences: async input => { received.push(input); return { effective_preferences: [] }; } };
  const server = createMcpServer(app, { sourceApplication: 'codex', env: {}, registerResources: false,
    toolNames: ['get_collaboration_preferences'], ...options });
  try {
    for (const meta of metas) await server.server._requestHandlers.get('tools/call')({ method: 'tools/call',
      params: { name: 'get_collaboration_preferences', _meta: meta,
        arguments: { sessionId: 'model-supplied-id', projectPath: '/synthetic', taskPrompt: 'Synthetic native attribution' } }
    }, { requestId: 1 });
    return received;
  } finally { await server.close(); }
}

test('local native transport metadata binds each call, including a thread switch with a stale process environment', async () => {
  const received = await invoke({ env: { CODEX_THREAD_ID: a }, nativeRequestContext: nativeMcpRequestContextResolver('codex') },
    [metadata(a), metadata(b)]);
  assert.deepEqual(received.map(value => value.sessionId), [a, b]);
  assert.deepEqual(received.map(value => value.sourceSessionId), [a, b]);
  assert.ok(received.every(value => value.sourceApplication === 'codex'));
});

test('request metadata is inert without the local adapter and cannot replace an explicit remote host binding', async () => {
  const ordinary = await invoke({}, [metadata(a)]);
  assert.match(ordinary[0].sourceSessionId, /^fuli-host-/);
  const remote = await invoke({ hostSessionId: 'fuli-remote-synthetic',
    env: { CODEX_THREAD_ID: b },
    prepareToolInput: (_name, value) => ({ ...value, sessionId: 'fuli-remote-synthetic' }),
    nativeRequestContext: nativeMcpRequestContextResolver('codex') }, [metadata(a)]);
  assert.equal(remote[0].sourceSessionId, 'fuli-remote-synthetic');
  assert.equal(remote[0].sessionId, 'fuli-remote-synthetic');
});

test('each call names its calling session for the process registry: the host one first, else the task entry one', async () => {
  const seen = [];
  const onSession = sessionId => seen.push(sessionId);
  await invoke({ env: { CODEX_THREAD_ID: a }, nativeRequestContext: nativeMcpRequestContextResolver('codex'), onSession },
    [metadata(a), metadata(b)]);
  assert.deepEqual(seen, [a, b]);
  seen.length = 0;
  await invoke({ onSession }, [undefined]);
  assert.deepEqual(seen, ['model-supplied-id']);
  seen.length = 0;
  // An identity FULI made for a process is no session the person can open.
  await invoke({ onSession, prepareToolInput: (_name, value) => ({ ...value, sessionId: 'fuli-host-synthetic' }) }, [undefined]);
  assert.deepEqual(seen, [null]);
});

test('unknown or malformed native metadata cannot establish identity or a context generation', () => {
  const resolve = nativeMcpRequestContextResolver('codex');
  assert.equal(resolve({ thread_id: a, session_id: execution }), null);
  assert.throws(() => resolve({ threadId: 'invented-id', sessionId: execution }), /native request identity/);
  assert.throws(() => resolve({ threadId: a, sessionId: 'invalid' }), /native request identity/);
  const known = resolve(metadata(a));
  assert.equal(known.nativeSessionId, a);
  assert.equal(known.nativeExecutionId, execution);
  assert.equal(known.contextWindowId, 'native-window-1');
  assert.equal(nativeMcpRequestContextResolver('claude_code'), null);
});

test('malformed host identity cannot fall back to an old process session or enter a business handler', async () => {
  let calls = 0;
  const server = createMcpServer({ getCollaborationPreferences: async () => { calls++; return {}; } }, {
    sourceApplication: 'codex', env: { CODEX_THREAD_ID: a }, registerResources: false,
    nativeRequestContext: nativeMcpRequestContextResolver('codex'), toolNames: ['get_collaboration_preferences']
  });
  try {
    const result = await server.server._requestHandlers.get('tools/call')({ method: 'tools/call', params: {
      name: 'get_collaboration_preferences', arguments: { projectPath: '/synthetic' },
      _meta: { threadId: 'invalid-current-thread', sessionId: execution }
    } }, { requestId: 1 });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'validation');
    assert.equal(calls, 0);
  } finally { await server.close(); }
});
