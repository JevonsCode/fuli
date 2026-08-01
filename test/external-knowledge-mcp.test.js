import assert from 'node:assert/strict';
import test from 'node:test';

import { createMcpConnector } from '../src/external-knowledge/connectors/mcp.js';

test('MCP check trusts negotiated server capabilities instead of client method presence', async () => {
  let closed = 0;
  const connector = createMcpConnector({
    openSession: async () => ({
      client: {
        getServerCapabilities: () => ({}),
        listResources: async () => ({ resources: [] }),
        listTools: async () => ({ tools: [] })
      },
      close: async () => { closed += 1; }
    })
  });

  const result = await connector.check({
    config: { transport: 'http', url: 'https://mcp.example.test' },
    source: {},
    mode: 'hybrid',
    env: {}
  });

  assert.deepEqual(result.capabilities, []);
  assert.equal(closed, 1);
});

test('MCP connector mirrors resources using list/read only and closes every session', async () => {
  const calls = [];
  let closed = 0;
  const client = {
    listResources: async (input) => {
      calls.push(['listResources', input]);
      return {
        resources: [{
          uri: 'https://kb.example.test/guide',
          name: 'Guide',
          mimeType: 'text/markdown'
        }],
        nextCursor: 'page-2'
      };
    },
    readResource: async (input) => {
      calls.push(['readResource', input]);
      return {
        contents: [{
          uri: input.uri,
          mimeType: 'text/markdown',
          text: '# Guide\n\nUse the setup command.'
        }]
      };
    }
  };
  const connector = createMcpConnector({
    openSession: async () => ({ client, close: async () => { closed += 1; } })
  });

  const result = await connector.sync({
    config: { transport: 'http', url: 'https://mcp.example.test' },
    source: { resourceUriPrefix: 'https://kb.example.test/' },
    cursor: 'page-1',
    env: {}
  });

  assert.deepEqual(calls, [
    ['listResources', { cursor: 'page-1' }],
    ['readResource', { uri: 'https://kb.example.test/guide' }]
  ]);
  assert.deepEqual(result, {
    items: [{
      id: 'https://kb.example.test/guide',
      title: 'Guide',
      content: '# Guide\n\nUse the setup command.',
      url: 'https://kb.example.test/guide',
      updatedAt: null,
      metadata: {
        mimeType: 'text/markdown',
        mcpUri: 'https://kb.example.test/guide'
      }
    }],
    deleted: [],
    nextCursor: 'page-2',
    hasMore: true
  });
  assert.equal(closed, 1);
});

test('MCP connector locally bounds an oversized server resource page with a resumable cursor', async () => {
  const reads = [];
  const client = {
    listResources: async () => ({
      resources: Array.from({ length: 3 }, (_, index) => ({
        uri: `https://kb.example.test/doc-${index + 1}`,
        name: `Doc ${index + 1}`
      }))
    }),
    readResource: async ({ uri }) => {
      reads.push(uri);
      return { contents: [{ uri, mimeType: 'text/plain', text: uri }] };
    }
  };
  const connector = createMcpConnector({
    openSession: async () => ({ client, close: async () => {} })
  });

  const first = await connector.sync({
    config: {},
    source: {},
    cursor: null,
    limit: 2,
    env: {}
  });
  const second = await connector.sync({
    config: {},
    source: {},
    cursor: first.nextCursor,
    limit: 2,
    env: {}
  });

  assert.equal(first.items.length, 2);
  assert.equal(first.hasMore, true);
  assert.match(first.nextCursor, /^fuli-mcp-v1:/);
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].id, 'https://kb.example.test/doc-3');
  assert.equal(second.hasMore, false);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set(reads).size, 3);
});
