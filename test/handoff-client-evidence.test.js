import test from 'node:test';
import assert from 'node:assert/strict';
import { clientEvidence, publicClientEvidence } from '../acceptance/handoff-live/clients.js';

const result = (...events) => ({ code: 0, stdout: events.map(event => JSON.stringify(event)).join('\n') });
test('Codex evidence requires completed tool results, and preserves labelled actual usage', () => {
  const value = clientEvidence('codex', result(
    { type: 'thread.started', thread_id: 'native-session' },
    { type: 'item.started', item: { type: 'mcp_tool_call', tool: 'not_finished' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'read', status: 'completed' } },
    { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'write', status: 'completed', result: { isError: true } } },
    { type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 4 } }
  ));
  assert.equal(value.sessionId, 'native-session');
  assert.deepEqual(value.tools.map(tool => tool.succeeded), [true, false]);
  assert.equal(value.usage.source, 'executor');
  assert.equal(value.usage.input_tokens, 20);
});

test('published client evidence cannot persist echoed credentials or arbitrary error text', () => {
  const value = clientEvidence('claude_code', result({ type: 'result', is_error: true,
    result: 'API 401 Authorization: Bearer synthetic-secret' }));
  const published = JSON.stringify(publicClientEvidence(value));
  assert.equal(published.includes('synthetic-secret'), false);
  assert.equal(published.includes('Authorization'), false);
  assert.equal(publicClientEvidence(value).error, 'authentication_failed');
});
test('Claude evidence does not turn an attempted or failed tool into a successful result', () => {
  const value = clientEvidence('claude_code', result(
    { type: 'assistant', session_id: 'native-claude', message: { content: [
      { type: 'tool_use', id: 'a', name: 'read' }, { type: 'tool_use', id: 'b', name: 'write' }
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', is_error: true }] } },
    { type: 'result', is_error: true, result: 'failed' }
  ));
  assert.equal(value.tools[0].succeeded, false);
  assert.equal(value.tools[1].succeeded, undefined);
  assert.equal(value.usage, null);
  assert.ok(value.error);
});
