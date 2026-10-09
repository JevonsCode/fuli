import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { createGrokParticipant } from '../src/agents/grok/roundtable-participant.js';
import { createA2AParticipant } from '../src/agents/a2a/roundtable-participant.js';

// Protocol fixtures use the real installed A2A SDK; no model credentials or remote agents are exercised.
const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json' }
});
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const grokEnv = { XAI_API_KEY: 'fixture-xai-secret', XAI_MODEL: 'fixture-selected-model' };
const grokResult = {
  id: 'response-real-id', model: 'fixture-reported-model', status: 'completed',
  output: [{ type: 'reasoning', summary: [{ text: 'private reasoning' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A reasoned review.' }] }],
  usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42,
    input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 3 } }
};

function grokFixture(response = grokResult) {
  const calls = [];
  return { calls, participant: createGrokParticipant({ env: grokEnv, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/models') ? json({ data: [{ id: grokEnv.XAI_MODEL }] }) : json(response);
  } }) };
}

const card = (changes = {}) => ({
  name: 'External reviewer', description: 'Fixture agent', version: '1',
  supportedInterfaces: [{ url: 'https://agent.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
  capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
  ...changes
});
const remoteTask = (state, changes = {}) => ({
  id: 'remote-task', contextId: 'remote-context', status: { state }, artifacts: [], history: [], ...changes
});

function a2aFixture(handler, { agentCard = card(), env = { FULI_A2A_TOKEN: 'fixture-a2a-secret' }, ...options } = {}) {
  const calls = [];
  const participant = createA2AParticipant({ url: 'https://agent.example', env,
    lookupImpl: publicLookup, pollIntervalMs: 1, ...options,
    fetchImpl: async (url, init) => {
      const request = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: String(url), init, request });
      if (!request) return json(agentCard);
      const result = await handler(request, init, calls);
      return result instanceof Response ? result : json({ jsonrpc: '2.0', id: request.id, result });
    }
  });
  return { participant, calls };
}

test('Grok protocol preflight requires an explicit key and model before any network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('unexpected request'); };
  assert.equal((await createGrokParticipant({ env: {}, fetchImpl }).preflight()).code, 'missing_api_key');
  assert.equal((await createGrokParticipant({ env: { XAI_API_KEY: 'fixture' }, fetchImpl }).preflight()).code, 'missing_model');
  assert.equal((await createGrokParticipant({ env: grokEnv, baseUrl: 'https://other.example/v1', fetchImpl }).preflight()).code, 'invalid_endpoint');
  assert.equal(calls, 0);
});

test('Grok protocol uses authenticated catalog preflight and actual response identity and token usage', async () => {
  const { participant, calls } = grokFixture();
  assert.equal((await participant.preflight()).ready, true);
  const result = await participant.dispatch({ prompt: 'Review the proposal.' });
  assert.equal(result.body, 'A reasoned review.');
  assert.equal(result.actual.sourceApplication, 'other');
  assert.equal(result.actual.model, 'fixture-reported-model');
  assert.equal(result.actual.sessionId, 'response-real-id');
  assert.deepEqual(result.actual.usage, { source: 'executor', totalTokens: 42, inputTokens: 30,
    outputTokens: 12, cachedInputTokens: 8, cacheWriteInputTokens: null, reasoningOutputTokens: 3 });
  assert.equal(calls[0].url, 'https://api.x.ai/v1/models');
  const request = JSON.parse(calls[1].init.body);
  assert.equal(request.model, grokEnv.XAI_MODEL);
  assert.equal(request.store, false);
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.headers.Authorization, `Bearer ${grokEnv.XAI_API_KEY}`);
  assert.ok(!JSON.stringify(result).includes(grokEnv.XAI_API_KEY));
  await participant.close();
});

test('Grok protocol checks selected model availability without falling back to a different model', async () => {
  const participant = createGrokParticipant({ env: grokEnv, fetchImpl: async () => json({ data: [{ id: 'different' }] }) });
  const result = await participant.preflight();
  assert.equal(result.ready, false);
  assert.equal(result.code, 'model_unavailable');
});

test('Grok protocol authentication failure is not retried and does not expose the remote error body', async () => {
  let calls = 0;
  const participant = createGrokParticipant({ env: grokEnv, fetchImpl: async () => {
    calls++;
    return json({ error: { message: grokEnv.XAI_API_KEY } }, 401);
  } });
  await assert.rejects(participant.dispatch({ prompt: 'Review.' }), (error) => {
    assert.equal(error.code, 'waiting_auth');
    assert.ok(!error.message.includes(grokEnv.XAI_API_KEY));
    return true;
  });
  assert.equal(calls, 1);
});

test('Grok protocol preserves unknown usage, excludes reasoning and redacts reflected credentials', async () => {
  const response = { ...grokResult, usage: {}, output: [{ type: 'message', role: 'assistant',
    content: [{ type: 'output_text', text: `Review ${grokEnv.XAI_API_KEY}` }] }] };
  const result = await grokFixture(response).participant.dispatch({ prompt: 'Review.' });
  assert.equal(result.body, 'Review [REDACTED_SECRET]');
  assert.equal(result.actual.usage, null);
});

test('Grok protocol rejects incomplete, empty and oversized UTF-8 outputs', async () => {
  for (const [response, code] of [
    [{ ...grokResult, status: 'incomplete' }, 'response_incomplete'],
    [{ ...grokResult, output: [{ type: 'reasoning', content: [{ text: 'hidden' }] }] }, 'response_invalid'],
    [{ ...grokResult, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中'.repeat(6000) }] }] }, 'output_too_large']
  ]) await assert.rejects(grokFixture(response).participant.dispatch({ prompt: 'Review.' }), { code });
});

test('Grok protocol interruption reports remote cancellation as unconfirmed', async () => {
  const controller = new AbortController();
  const participant = createGrokParticipant({ env: grokEnv, fetchImpl: async (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error(grokEnv.XAI_API_KEY)), { once: true });
    controller.abort();
  }) });
  await assert.rejects(participant.dispatch({ prompt: 'Review.', signal: controller.signal }), (error) => {
    assert.equal(error.code, 'cancelled');
    assert.equal(error.cancellationConfirmed, false);
    assert.ok(!error.message.includes(grokEnv.XAI_API_KEY));
    return true;
  });
});

test('A2A protocol discovers the configured same-origin public interface using the real SDK', async () => {
  const { participant, calls } = a2aFixture(async () => { throw new Error('preflight must not dispatch'); });
  const result = await participant.preflight();
  assert.equal(result.ready, true);
  assert.equal(result.name, 'External reviewer');
  assert.equal(result.protocolVersion, '1.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://agent.example/.well-known/agent-card.json');
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer fixture-a2a-secret');
  assert.equal(calls[0].init.redirect, 'error');
  await participant.close();
});

test('A2A protocol rejects nonpublic endpoints, private DNS answers and cross-origin card interfaces', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return json(card()); };
  for (const url of ['http://agent.example', 'https://127.0.0.1', 'https://192.168.0.1', 'https://[::1]',
    'https://localhost', 'https://private.local', 'https://user:password@agent.example']) {
    assert.equal((await createA2AParticipant({ url, fetchImpl, lookupImpl: publicLookup }).preflight()).code, 'invalid_endpoint');
  }
  const privateDns = createA2AParticipant({ url: 'https://agent.example', fetchImpl,
    lookupImpl: async () => [{ address: '10.0.0.8', family: 4 }] });
  assert.equal((await privateDns.preflight()).code, 'invalid_endpoint');
  assert.equal(calls, 0);
  const fixture = a2aFixture(async () => {}, { agentCard: card({ supportedInterfaces: [
    { url: 'https://other.example/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }
  ] }) });
  assert.equal((await fixture.participant.preflight()).code, 'invalid_endpoint');
  assert.equal(fixture.calls.length, 1);
});

test('A2A protocol rejects discovery redirects and does not forward authorization to another origin', async () => {
  let calls = 0;
  const participant = createA2AParticipant({ url: 'https://agent.example', env: { FULI_A2A_TOKEN: 'fixture' }, lookupImpl: publicLookup,
    fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'error');
      const response = json(card());
      Object.defineProperty(response, 'url', { value: 'https://other.example/card' });
      return response;
    } });
  assert.equal((await participant.preflight()).code, 'invalid_endpoint');
  assert.equal(calls, 1);
});

test('A2A protocol authenticates without retrying rejected credentials or exposing response errors', async () => {
  const { participant, calls } = a2aFixture(async () => json({ error: 'fixture-a2a-secret' }, 403));
  assert.equal((await participant.preflight()).ready, true);
  await assert.rejects(participant.dispatch({ prompt: 'Review.' }), (error) => {
    assert.equal(error.code, 'waiting_auth');
    assert.ok(!error.message.includes('fixture-a2a-secret'));
    return true;
  });
  assert.equal(calls.length, 2);
});

test('A2A protocol polls an actual SDK task lifecycle and returns text artifacts with remote identity', async () => {
  const { participant, calls } = a2aFixture(async (request) => request.method === 'SendMessage'
    ? { task: remoteTask('TASK_STATE_WORKING') }
    : remoteTask('TASK_STATE_COMPLETED', { artifacts: [{ artifactId: 'review', name: 'Review', parts: [{ text: 'Supported findings.' }] }],
      metadata: { model: 'remote-reported-model', usage: { total_tokens: 17, input_tokens: 10, output_tokens: 7 } } }));
  const result = await participant.dispatch({ prompt: 'Review the design.', turn: { id: 'turn-1', attemptId: 'attempt-1' } });
  assert.equal(result.body, 'Supported findings.');
  assert.equal(result.actual.sourceApplication, 'other');
  assert.equal(result.actual.sessionId, 'remote-context');
  assert.equal(result.actual.remoteTaskId, 'remote-task');
  assert.equal(result.actual.model, 'remote-reported-model');
  assert.equal(result.actual.usage.totalTokens, 17);
  assert.deepEqual(result.artifacts, [{ artifactId: 'review', name: 'Review', text: 'Supported findings.' }]);
  const sent = calls.find((call) => call.request?.method === 'SendMessage').request.params;
  assert.equal(sent.message.role, 'ROLE_USER');
  assert.deepEqual(sent.message.parts, [{ text: 'Review the design.' }]);
  assert.deepEqual(sent.message.metadata.fuli, { turnId: 'turn-1', attemptId: 'attempt-1' });
  assert.ok(calls.some((call) => call.request?.method === 'GetTask'));
  await participant.close();
});

test('A2A protocol direct agent messages retain context while unknown model and usage stay null', async () => {
  const { participant, calls } = a2aFixture(async () => ({ message: { messageId: 'agent-message', contextId: 'message-context',
    role: 'ROLE_AGENT', parts: [{ text: 'A direct response.' }] } }));
  const result = await participant.dispatch({ prompt: 'Review.' });
  assert.equal(result.body, 'A direct response.');
  assert.equal(result.actual.sessionId, 'message-context');
  assert.equal(result.actual.model, null);
  assert.equal(result.actual.usage, null);
  await participant.dispatch({ prompt: 'Continue.' });
  assert.equal(calls.filter((call) => call.request)[1].request.params.message.contextId, 'message-context');
});

test('A2A protocol input-required preserves the remote task and question for a later response', async () => {
  let turns = 0;
  const { participant, calls } = a2aFixture(async () => {
    if (++turns === 1) return { task: remoteTask('TASK_STATE_INPUT_REQUIRED', {
      status: { state: 'TASK_STATE_INPUT_REQUIRED', message: { role: 'ROLE_AGENT', messageId: 'question', parts: [{ text: 'Which branch?' }] } }
    }) };
    return { task: remoteTask('TASK_STATE_COMPLETED', { artifacts: [{ artifactId: 'result', parts: [{ text: 'Resolved.' }] }] }) };
  });
  await assert.rejects(participant.dispatch({ prompt: 'Review.' }), (error) => {
    assert.equal(error.code, 'waiting_input');
    assert.equal(error.body, 'Which branch?');
    assert.equal(error.remoteTaskId, 'remote-task');
    return true;
  });
  assert.equal((await participant.dispatch({ prompt: 'Use the review branch.' })).body, 'Resolved.');
  const sent = calls.filter((call) => call.request)[1].request.params.message;
  assert.equal(sent.taskId, 'remote-task');
  assert.equal(sent.contextId, 'remote-context');
});

test('A2A protocol consumes SDK SSE status and appended artifact updates', async () => {
  const { participant } = a2aFixture(async (request) => {
    assert.equal(request.method, 'SendStreamingMessage');
    const events = [{ task: remoteTask('TASK_STATE_WORKING') },
      { artifactUpdate: { taskId: 'remote-task', contextId: 'remote-context', artifact: { artifactId: 'review', name: 'Review', parts: [{ text: 'First ' }] } } },
      { artifactUpdate: { taskId: 'remote-task', contextId: 'remote-context', append: true, lastChunk: true,
        artifact: { artifactId: 'review', name: 'Review', parts: [{ text: 'second.' }] } } },
      { statusUpdate: { taskId: 'remote-task', contextId: 'remote-context', status: { state: 'TASK_STATE_COMPLETED' } } }];
    return new Response(events.map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } });
  }, { agentCard: card({ capabilities: { streaming: true } }) });
  assert.equal((await participant.dispatch({ prompt: 'Review.' })).body, 'First second.');
});

test('A2A protocol abort requests remote cancellation and requires a canceled acknowledgment', async () => {
  for (const confirmed of [true, false]) {
    const controller = new AbortController();
    const { participant, calls } = a2aFixture(async (request) => {
      if (request.method === 'SendMessage') {
        setTimeout(() => controller.abort(), 10);
        return { task: remoteTask('TASK_STATE_WORKING') };
      }
      assert.equal(request.method, 'CancelTask');
      assert.equal(request.params.id, 'remote-task');
      return remoteTask(confirmed ? 'TASK_STATE_CANCELED' : 'TASK_STATE_WORKING');
    }, { pollIntervalMs: 100 });
    await assert.rejects(participant.dispatch({ prompt: 'Review.', signal: controller.signal }), (error) => {
      assert.equal(error.code, 'cancelled');
      assert.equal(error.cancellationConfirmed, confirmed);
      assert.equal(error.remoteTaskId, 'remote-task');
      return true;
    });
    assert.equal(calls.filter((call) => call.request?.method === 'CancelTask').length, 1);
    await participant.close();
  }
});

test('A2A protocol rejects mismatched tasks, failed tasks and oversized UTF-8 output', async () => {
  const oversized = a2aFixture(async () => ({ message: { messageId: 'response', contextId: 'context', role: 'ROLE_AGENT',
    parts: [{ text: '中'.repeat(6000) }] } }));
  await assert.rejects(oversized.participant.dispatch({ prompt: 'Review.' }), { code: 'output_too_large' });
  const failed = a2aFixture(async () => ({ task: remoteTask('TASK_STATE_FAILED') }));
  await assert.rejects(failed.participant.dispatch({ prompt: 'Review.' }), { code: 'remote_failed' });
  const mismatch = a2aFixture(async (request) => request.method === 'SendMessage'
    ? { task: remoteTask('TASK_STATE_WORKING') }
    : remoteTask('TASK_STATE_COMPLETED', { id: 'another-task' }));
  await assert.rejects(mismatch.participant.dispatch({ prompt: 'Review.' }), { code: 'response_invalid' });
});

test('A2A protocol DNS discovery obeys interruption without starting HTTP', async () => {
  const controller = new AbortController();
  let calls = 0;
  const participant = createA2AParticipant({ url: 'https://agent.example',
    lookupImpl: async () => new Promise(() => {}),
    fetchImpl: async () => { calls++; return json(card()); } });
  const pending = participant.preflight({ signal: controller.signal });
  controller.abort();
  assert.equal((await pending).code, 'cancelled');
  assert.equal(calls, 0);
});

test('A2A protocol releases an open SSE connection when it receives a completed task', async () => {
  let streamCancelled = false;
  const { participant } = a2aFixture(async (request) => {
    const result = { task: remoteTask('TASK_STATE_COMPLETED', {
      artifacts: [{ artifactId: 'final', parts: [{ text: 'Finished.' }] }]
    }) };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`));
      },
      cancel() { streamCancelled = true; }
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  }, { agentCard: card({ capabilities: { streaming: true } }) });
  assert.equal((await participant.dispatch({ prompt: 'Review.' })).body, 'Finished.');
  assert.equal(streamCancelled, true);
});

test('A2A protocol interim agent messages cannot complete a working task', async () => {
  const { participant, calls } = a2aFixture(async (request) => {
    if (request.method === 'GetTask') return remoteTask('TASK_STATE_COMPLETED', {
      artifacts: [{ artifactId: 'final', parts: [{ text: 'Verified final.' }] }]
    });
    const events = [{ task: remoteTask('TASK_STATE_WORKING') },
      { message: { messageId: 'progress', contextId: 'remote-context', taskId: 'remote-task', role: 'ROLE_AGENT', parts: [{ text: 'Still working.' }] } }];
    return new Response(events.map((result) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } });
  }, { agentCard: card({ capabilities: { streaming: true } }) });
  assert.equal((await participant.dispatch({ prompt: 'Review.' })).body, 'Verified final.');
  assert.ok(calls.some((call) => call.request?.method === 'GetTask'));
});

test('A2A protocol requires agent-authored task output and matching message contexts', async () => {
  const echoedUser = a2aFixture(async () => ({ task: remoteTask('TASK_STATE_COMPLETED', {
    status: { state: 'TASK_STATE_COMPLETED', message: { messageId: 'echo', role: 'ROLE_USER', parts: [{ text: 'Review.' }] } }
  }) }));
  await assert.rejects(echoedUser.participant.dispatch({ prompt: 'Review.' }), { code: 'response_invalid' });
  let count = 0;
  const mismatch = a2aFixture(async () => ({ message: { messageId: 'agent', role: 'ROLE_AGENT',
    contextId: ++count === 1 ? 'original-context' : 'different-context', parts: [{ text: 'Result.' }] } }));
  await mismatch.participant.dispatch({ prompt: 'Review.' });
  await assert.rejects(mismatch.participant.dispatch({ prompt: 'Continue.' }), { code: 'response_invalid' });
});

test('external protocol failures preserve reported actual usage while transport responses remain bounded', async () => {
  await assert.rejects(grokFixture({ ...grokResult, status: 'incomplete' }).participant.dispatch({ prompt: 'Review.' }), (error) => {
    assert.equal(error.code, 'response_incomplete');
    assert.equal(error.actual.usage.totalTokens, 42);
    return true;
  });
  const failed = a2aFixture(async () => ({ task: remoteTask('TASK_STATE_FAILED', { metadata: { usage: { total_tokens: 9 } } }) }));
  await assert.rejects(failed.participant.dispatch({ prompt: 'Review.' }), (error) => {
    assert.equal(error.actual.remoteTaskId, 'remote-task');
    assert.equal(error.actual.usage.totalTokens, 9);
    return true;
  });
  const largeResponse = createGrokParticipant({ env: grokEnv, fetchImpl: async () => json({ large: 'x'.repeat(1024 * 1024) }) });
  await assert.rejects(largeResponse.dispatch({ prompt: 'Review.' }), { code: 'response_too_large' });
});

test('A2A default HTTPS protocol transport pins the validated DNS answers through connection lookup', async () => {
  const lookups = [];
  const requests = [];
  const participant = createA2AParticipant({ url: 'https://agent.example', env: {}, lookupImpl: publicLookup,
    httpsRequestImpl: (url, options, onResponse) => {
      requests.push({ url: String(url), options });
      options.lookup('agent.example', { all: true }, (error, addresses) => {
        assert.equal(error, null);
        lookups.push(addresses);
      });
      const request = new EventEmitter();
      request.end = (body) => {
        const rpc = body ? JSON.parse(body) : null;
        const value = rpc ? { jsonrpc: '2.0', id: rpc.id, result: { message: {
          role: 'ROLE_AGENT', messageId: 'native-response', contextId: 'native-context', parts: [{ text: 'Pinned transport result.' }]
        } } } : card();
        queueMicrotask(() => onResponse(Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), {
          statusCode: 200, statusMessage: 'OK', headers: { 'content-type': 'application/json' }
        })));
      };
      return request;
    } });
  assert.equal((await participant.preflight()).ready, true);
  assert.equal((await participant.dispatch({ prompt: 'Review.' })).body, 'Pinned transport result.');
  assert.equal(requests.length, 2);
  assert.deepEqual(lookups, [[{ address: '8.8.8.8', family: 4 }], [{ address: '8.8.8.8', family: 4 }]]);
});
