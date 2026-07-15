import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('real web app switches views and lazily renders memory through DOM events', async () => {
  const { parseHTML } = await import('linkedom');
  const { window } = parseHTML(readFileSync('web/index.html', 'utf8'));
  const requests = [];
  installDom(window);
  for (const select of document.querySelectorAll('select')) {
    Object.defineProperty(select, 'value', { value: '', writable: true });
  }
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return responseFor(String(url));
  };

  await import(`../web/app.js?smoke=${Date.now()}`);
  const overview = document.querySelector('[data-view-panel="overview"]');
  const memory = document.querySelector('[data-view-panel="memory"]');
  assert.equal(requests.some((url) => url.startsWith('/api/lens')), false);

  document.querySelector('[data-view="memory"]').dispatchEvent(new window.Event('click'));
  await settle();
  assert.equal(overview.hidden, true);
  assert.equal(memory.hidden, false);
  assert.equal(requests.some((url) => url.startsWith('/api/lens')), true);
  assert.match(document.querySelector('#lens-list').textContent, /偏好 中文.*已确认/s);
});

function installDom(window) {
  for (const key of ['window', 'document', 'Event', 'Node', 'HTMLElement']) {
    globalThis[key] = window[key] ?? window;
  }
}

function responseFor(url) {
  const state = {
    spaces: [
      { id: 'personal-1', name: '我', kind: 'personal' },
      { id: 'public-1', name: '工作', kind: 'public' }
    ],
    subscriptions: [], candidates: [], currentFacts: [], historicalFacts: []
  };
  const lens = {
    facts: [{
      subject: 'user', predicate: 'has_偏好', object: '中文', status: 'confirmed',
      validAt: '2026-07-11T00:00:00.000Z',
      source: { kind: 'conversation', uri: null, createdAt: '2026-07-11T00:00:00.000Z' }
    }]
  };
  return { ok: true, json: async () => url.startsWith('/api/lens') ? lens : state };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
