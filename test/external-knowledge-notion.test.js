import assert from 'node:assert/strict';
import test from 'node:test';

import { createNotionConnector } from '../src/external-knowledge/connectors/notion.js';

test('Notion binding check requires an explicit read scope before making a request', async () => {
  let requests = 0;
  const connector = createNotionConnector({
    fetchImpl: async () => {
      requests += 1;
      return new Response('{}');
    }
  });

  await assert.rejects(
    connector.check({
      config: { tokenEnv: 'NOTION_READ_TOKEN' },
      source: {},
      env: { NOTION_READ_TOKEN: 'test-token' }
    }),
    /requires pageIds or dataSourceIds/i
  );
  assert.equal(requests, 0);
});

test('Notion connector reads explicit pages as markdown with the current API version', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      method: options.method ?? 'GET',
      authorization: options.headers.Authorization,
      version: options.headers['Notion-Version']
    });
    const payload = url.pathname.endsWith('/markdown')
      ? {
          object: 'page_markdown',
          id: 'page-1',
          markdown: '# Handbook\n\nRead-only content.',
          truncated: false,
          unknown_block_ids: []
        }
      : {
          object: 'page',
          id: 'page-1',
          url: 'https://notion.so/page-1',
          last_edited_time: '2026-07-30T10:00:00.000Z',
          properties: {
            Name: { type: 'title', title: [{ plain_text: 'Handbook' }] }
          }
        };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const connector = createNotionConnector({ fetchImpl });

  const result = await connector.sync({
    config: { tokenEnv: 'NOTION_READ_TOKEN' },
    source: { pageIds: ['page-1'] },
    cursor: null,
    limit: 100,
    env: { NOTION_READ_TOKEN: 'test-token' }
  });

  assert.deepEqual(calls, [
    {
      path: '/v1/pages/page-1',
      method: 'GET',
      authorization: 'Bearer test-token',
      version: '2026-03-11'
    },
    {
      path: '/v1/pages/page-1/markdown',
      method: 'GET',
      authorization: 'Bearer test-token',
      version: '2026-03-11'
    }
  ]);
  assert.equal(result.items[0].title, 'Handbook');
  assert.equal(result.items[0].content, '# Handbook\n\nRead-only content.');
  assert.equal(result.items[0].updatedAt, '2026-07-30T10:00:00.000Z');
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.ok(calls.every(({ method }) => ['GET', 'POST'].includes(method)));
});
