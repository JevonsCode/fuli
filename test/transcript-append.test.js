import assert from 'node:assert/strict';
import test from 'node:test';

import { appendTranscriptPage, CREDENTIAL_OMISSION } from '../src/conversations/transcript-append.js';
import { ProviderRequestError } from '../src/graphiti/provider-client.js';

const events = ['first', 'synthetic password=fixture-only', 'third'].map((content, index) => ({
  event_id: `jsonl-v1:${index}`, role: 'tool', kind: 'tool_result', content
}));
const rejection = (failures, status = 422) => new ProviderRequestError('rejected', {
  status, validationErrors: failures
});
const credential = (index) => ({ field: `events[${index}]`, message: 'Value error, Conversation event contains credentials' });

function provider(...answers) {
  const calls = [];
  return {
    calls,
    personal: {
      async conversation(action, request) {
        calls.push({ action, request });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      }
    }
  };
}

test('only the events the Provider flags as credentials are replaced, once', async () => {
  const app = provider(rejection([credential(1)]), { status: 'saved' });
  const result = await appendTranscriptPage(app, { session_id: 's', expected_cursor: 10, cursor: 20, events });

  assert.deepEqual(result, { status: 'saved' });
  assert.equal(app.calls.length, 2);
  const retried = app.calls[1].request;
  assert.deepEqual(retried.events.map(({ content }) => content), ['first', CREDENTIAL_OMISSION, 'third']);
  assert.deepEqual([retried.expected_cursor, retried.cursor], [10, 20]);
  assert.equal(JSON.stringify(retried).includes('fixture-only'), false);
});

test('a second rejection after the replacement is reported, not retried again', async () => {
  const app = provider(rejection([credential(1)]), rejection([credential(0)]));
  await assert.rejects(appendTranscriptPage(app, { events }), /rejected/);
  assert.equal(app.calls.length, 2);
});

test('any other rejection is rethrown unchanged without a retry', async () => {
  for (const error of [
    rejection([credential(1), { field: 'cursor', message: 'Value error, stale cursor' }]),
    rejection([{ field: 'events[1]', message: 'Value error, too long' }]),
    rejection([credential(7)]),
    rejection([credential(1)], 409),
    new ProviderRequestError('unavailable', { status: 503, code: 'provider_http_5xx' }),
    new Error('network')
  ]) {
    const app = provider(error);
    await assert.rejects(appendTranscriptPage(app, { events }), (caught) => caught === error);
    assert.equal(app.calls.length, 1);
  }
});
