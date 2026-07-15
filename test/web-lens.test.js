import assert from 'node:assert/strict';
import test from 'node:test';

import { readWebFile, webSource } from '../test-support/web-source.js';

test('personal memory loads only when its view becomes active', () => {
  const html = readWebFile('index.html');
  const app = webSource('app.js', 'js/lens.js', 'js/state.js');

  assert.match(html, /data-view-panel="memory" hidden/);
  assert.match(app, /if \(isViewActive\('memory'\)\) await refreshLens\(\)/);
  assert.match(app, /const personalSpaceId = elements\.activePersonal\.value/);
  assert.match(app, /new URLSearchParams\(\{ personalSpaceId, budget: '1200' \}\)/);
  assert.match(app, /\/api\/lens\?\$\{params\.toString\(\)\}/);
});

test('personal memory renders localized statuses and untrusted values as text', () => {
  const app = readWebFile('js/lens-view.js');

  assert.match(app, /confirmed: '已确认'/);
  assert.match(app, /observed: '观察到'/);
  assert.match(app, /content\.textContent = `\$\{humanPredicate\(fact\.predicate\)\} \$\{fact\.object\}`/);
  assert.doesNotMatch(app, /innerHTML.*fact\.object/);
  assert.match(app, /empty\.textContent = '还没有内容'/);
});

test('personal memory ignores stale success after a faster space switch', async () => {
  const { createLensController } = await import('../web/js/lens.js');
  const first = deferred();
  const second = deferred();
  const elements = lensElements('space-a');
  const rendered = [];
  const errors = [];
  const requests = [];
  const controller = createLensController({
    elements,
    getJson: (url) => {
      requests.push(url);
      return requests.length === 1 ? first.promise : second.promise;
    },
    renderLensFacts: (facts) => rendered.push(facts),
    handleActionError: (error) => errors.push(error.message)
  });

  const slow = controller.refreshLens();
  elements.activePersonal.value = 'space-b';
  const fast = controller.refreshLens();
  second.resolve({ facts: [{ object: 'new' }] });
  await fast;
  first.resolve({ facts: [{ object: 'old' }] });
  await slow;

  assert.deepEqual(rendered, [[{ object: 'new' }]]);
  assert.deepEqual(errors, []);
  assert.match(requests[0], /personalSpaceId=space-a/);
  assert.match(requests[1], /personalSpaceId=space-b/);
  assert.equal(elements.lensList.clears, 2);
});

test('personal memory ignores stale failure after a newer success', async () => {
  const { createLensController } = await import('../web/js/lens.js');
  const first = deferred();
  const second = deferred();
  const elements = lensElements('space-a');
  const rendered = [];
  const errors = [];
  let calls = 0;
  const controller = createLensController({
    elements,
    getJson: () => (++calls === 1 ? first.promise : second.promise),
    renderLensFacts: (facts) => rendered.push(facts),
    handleActionError: (error) => errors.push(error.message)
  });

  const slow = controller.refreshLens();
  elements.activePersonal.value = 'space-b';
  const fast = controller.refreshLens();
  second.resolve({ facts: [{ object: 'new' }] });
  await fast;
  first.reject(new Error('stale failure'));
  await slow;

  assert.deepEqual(rendered, [[{ object: 'new' }]]);
  assert.deepEqual(errors, []);
});

test('personal memory clears old content for a current failure', async () => {
  const { createLensController } = await import('../web/js/lens.js');
  const elements = lensElements('space-a');
  const errors = [];
  const controller = createLensController({
    elements,
    getJson: async () => { throw new Error('current failure'); },
    renderLensFacts: () => {},
    handleActionError: (error) => errors.push(error.message)
  });

  await controller.refreshLens();

  assert.deepEqual(errors, ['current failure']);
  assert.equal(elements.lensList.clears, 2);
});

test('personal memory ignores a request that finishes after leaving the view', async () => {
  const { createLensController } = await import('../web/js/lens.js');
  const response = deferred();
  const active = { value: true };
  const rendered = [];
  const errors = [];
  const controller = createLensController({
    elements: lensElements('space-a'),
    getJson: () => response.promise,
    renderLensFacts: (facts) => rendered.push(facts),
    handleActionError: (error) => errors.push(error.message),
    isActive: () => active.value
  });

  const request = controller.refreshLens();
  active.value = false;
  response.reject(new Error('late failure'));
  await request;

  assert.deepEqual(rendered, []);
  assert.deepEqual(errors, []);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function lensElements(personalSpaceId) {
  return {
    activePersonal: { value: personalSpaceId },
    lensList: {
      clears: 0,
      replaceChildren() {
        this.clears += 1;
      }
    }
  };
}
