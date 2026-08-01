import assert from 'node:assert/strict';
import test from 'node:test';

import { createRetrievalApiConnector } from '../src/external-knowledge/connectors/retrieval-api.js';

test('retrieval API connector queries every bound knowledge base with stable provenance', async () => {
  const calls = [];
  const connector = createRetrievalApiConnector({
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({
        url,
        authorization: options.headers.Authorization,
        body
      });
      const suffix = body.knowledge_id === 'kb-a' ? 'a' : 'b';
      return new Response(JSON.stringify({
        records: [{
          content: `Result ${suffix}`,
          score: suffix === 'b' ? 0.93 : 0.71,
          title: `Document ${suffix}`,
          metadata: {
            segment_id: `segment-${suffix}`,
            url: `https://docs.example.test/${suffix}`
          }
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await connector.retrieve({
    config: {
      url: 'https://knowledge.example.test/retrieval',
      tokenEnv: 'RETRIEVAL_READ_TOKEN',
      scoreThreshold: 0.6
    },
    source: { knowledgeIds: ['kb-a', 'kb-b'] },
    env: { RETRIEVAL_READ_TOKEN: 'fixture-token' },
    query: 'release process',
    limit: 5
  });

  assert.deepEqual(calls.map(({ body }) => body), [
    {
      knowledge_id: 'kb-a',
      query: 'release process',
      retrieval_setting: { top_k: 5, score_threshold: 0.6 }
    },
    {
      knowledge_id: 'kb-b',
      query: 'release process',
      retrieval_setting: { top_k: 5, score_threshold: 0.6 }
    }
  ]);
  assert.ok(calls.every(({ authorization }) => authorization === 'Bearer fixture-token'));
  assert.deepEqual(result.items.map(({ id }) => id), [
    'kb-b:segment-b',
    'kb-a:segment-a'
  ]);
  assert.equal(result.items[0].metadata.knowledgeId, 'kb-b');
  assert.equal(result.items[0].url, 'https://docs.example.test/b');
});

test('retrieval API connector permits only HTTPS or explicit loopback HTTP endpoints', async () => {
  const connector = createRetrievalApiConnector({
    fetchImpl: async () => new Response(JSON.stringify({ records: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  });
  const context = {
    source: { knowledgeIds: ['kb-a'] },
    env: {},
    query: 'test',
    limit: 5
  };

  await assert.rejects(
    connector.retrieve({ ...context, config: { url: 'http://knowledge.example.test/retrieval' } }),
    /HTTPS or loopback HTTP/i
  );
  const result = await connector.retrieve({
    ...context,
    config: { url: 'http://127.0.0.1:8080/retrieval' }
  });
  assert.deepEqual(result.items, []);
});
