import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  enhanceSearchableSelects,
  syncSearchableSelects
} from '../web/js/searchable-select.js';
import { compactIdentity, graphNodeIdentity } from '../web/js/identity.js';

test('searchable select preserves the native form value and searches names or IDs', () => {
  const { document, window } = parseHTML(`
    <form>
      <select id="project" name="project" aria-label="个人项目" data-searchable="true">
        <option value="alpha" data-meta="#alpha" selected>项目 Alpha</option>
        <option value="beta" data-meta="#beta-2026">同名项目</option>
      </select>
    </form>
  `);
  globalThis.document = document;
  let changes = 0;
  const select = document.querySelector('#project');
  select.addEventListener('change', () => { changes += 1; });

  enhanceSearchableSelects(document);
  const trigger = document.querySelector('.searchable-select-trigger');
  assert.equal(trigger.getAttribute('role'), 'combobox');
  assert.match(trigger.textContent, /项目 Alpha#alpha/);

  trigger.dispatchEvent(new window.Event('click', { bubbles: true }));
  const search = document.querySelector('.searchable-select-search input');
  search.value = 'beta-2026';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  const visible = [...document.querySelectorAll('.searchable-select-option')]
    .filter((option) => !option.hidden);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].textContent.includes('同名项目'), true);

  visible[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(select.value, 'beta');
  assert.equal(changes, 1);
  assert.match(trigger.textContent, /同名项目#beta-2026/);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});

test('searchable select can be explicitly synchronized after dynamic options change', () => {
  const { document } = parseHTML(`
    <select id="dynamic" aria-label="项目">
      <option value="one" selected>项目一</option>
    </select>
  `);
  globalThis.document = document;
  const select = document.querySelector('#dynamic');
  enhanceSearchableSelects(select);
  const next = document.createElement('option');
  next.value = 'two';
  next.textContent = '项目二';
  next.dataset.meta = '#two';
  next.selected = true;
  select.replaceChildren(next);
  syncSearchableSelects(select);
  assert.match(document.querySelector('.searchable-select-trigger').textContent, /项目二#two/);
});

test('graph IDs use full canonical values underneath compact display identities', () => {
  assert.equal(compactIdentity('019f8593-bb30-7ff3-a45b-9d740c898ee4'), '019f8593');
  assert.equal(graphNodeIdentity({
    id: 'personal-project:space-id:fuli',
    attributes: { projectId: 'fuli' }
  }), 'fuli');
  assert.equal(graphNodeIdentity({ id: 'short-node-id' }), 'short-node-id');
});
