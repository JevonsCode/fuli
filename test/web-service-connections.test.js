import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { renderServiceConnections } from '../web/js/service-connections.js';

test('service connection status separates the local library from a disconnected public service', () => {
  const { document } = fixture();

  renderServiceConnections(document, {
    mode: 'personal_only',
    providers: { personal: { status: 'ready' }, workspaces: [] }
  });

  assert.equal(document.querySelector('#local-connection-state').textContent, '已连接');
  assert.equal(document.querySelector('#public-connection-state').textContent, '未连接');
  assert.equal(document.querySelector('#public-runtime-label').textContent, '公共服务未连接');
  assert.equal(document.querySelector('#public-connection-detail').textContent, '尚未配置');
});

test('service connection status explains degraded and connected public modes', () => {
  const { document } = fixture();

  renderServiceConnections(document, {
    mode: 'degraded',
    providers: { personal: { status: 'ready' }, workspaces: [{ status: 'error' }] }
  });
  assert.equal(document.querySelector('#public-connection-state').textContent, '连接异常');
  assert.match(document.querySelector('#public-runtime-copy').textContent, /本地知识库不受影响/);

  renderServiceConnections(document, {
    mode: 'connected',
    providers: { personal: { status: 'ready' }, workspaces: [{ status: 'ready' }] }
  });
  assert.equal(document.querySelector('#public-connection-state').textContent, '已连接');
  assert.equal(document.querySelector('#public-connection-detail').textContent, '1 个共享服务可用');
});

function fixture() {
  return parseHTML(`
    <i id="public-runtime-dot"></i><strong id="public-runtime-label"></strong>
    <small id="public-runtime-copy"></small>
    <article id="local-connection-card"><span id="local-connection-state"></span>
      <p id="local-connection-copy"></p></article>
    <article id="public-connection-card"><span id="public-connection-state"></span>
      <p id="public-connection-copy"></p><dd id="public-connection-detail"></dd></article>
  `);
}
