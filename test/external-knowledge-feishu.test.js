import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeishuConnector } from '../src/external-knowledge/connectors/feishu.js';

test('Feishu binding check requires an explicit wiki scope before making a request', async () => {
  let requests = 0;
  const connector = createFeishuConnector({
    fetchImpl: async () => {
      requests += 1;
      return new Response('{}');
    }
  });

  await assert.rejects(
    connector.check({
      config: { accessTokenEnv: 'FEISHU_READ_TOKEN' },
      source: {},
      env: { FEISHU_READ_TOKEN: 'test-token' }
    }),
    /requires nodeTokens or spaceId/i
  );
  assert.equal(requests, 0);
});

test('Feishu connector resolves a wiki node and reads docx raw content without source writes', async () => {
  const calls = [];
  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    calls.push({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: options.method ?? 'GET',
      authorization: options.headers.Authorization
    });
    const data = url.pathname.includes('/raw_content')
      ? { content: '只读知识库正文' }
      : {
          node: {
            space_id: 'space-1',
            node_token: 'wiki-node-1',
            obj_token: 'docx-1',
            obj_type: 'docx',
            title: '飞书手册',
            obj_edit_time: '1785492000',
            has_child: false
          }
        };
    return new Response(JSON.stringify({ code: 0, msg: 'success', data }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const connector = createFeishuConnector({ fetchImpl });

  const result = await connector.sync({
    config: { accessTokenEnv: 'FEISHU_READ_TOKEN', region: 'cn' },
    source: {
      nodeTokens: ['wiki-node-1'],
      webBaseUrl: 'https://example.feishu.cn'
    },
    cursor: null,
    limit: 50,
    env: { FEISHU_READ_TOKEN: 'test-token' }
  });

  assert.deepEqual(calls, [
    {
      path: '/open-apis/wiki/v2/spaces/get_node',
      query: { token: 'wiki-node-1' },
      method: 'GET',
      authorization: 'Bearer test-token'
    },
    {
      path: '/open-apis/docx/v1/documents/docx-1/raw_content',
      query: { lang: '0' },
      method: 'GET',
      authorization: 'Bearer test-token'
    }
  ]);
  assert.equal(result.items[0].id, 'wiki-node-1');
  assert.equal(result.items[0].title, '飞书手册');
  assert.equal(result.items[0].content, '只读知识库正文');
  assert.equal(result.items[0].url, 'https://example.feishu.cn/wiki/wiki-node-1');
  assert.ok(calls.every(({ method }) => method === 'GET'));
});
