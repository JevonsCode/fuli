import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createCaptureControl } from '../web/js/capture-control.js';

test('capture control renders persisted state and saves an explicit switch change', async () => {
  const { document } = parseHTML(
    '<label><span>自动沉淀</span><input type="checkbox"><i></i></label>'
  );
  const toggle = document.querySelector('input');
  const changes = [];
  const controller = createCaptureControl({
    toggle,
    update: async (enabled) => ({ enabled, updatedAt: '2026-07-22T10:00:00.000Z' }),
    onChange: (policy) => changes.push(policy),
    onError(error) { throw error; }
  });

  controller.render({ enabled: false });
  assert.equal(toggle.checked, false);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.match(toggle.closest('label').title, /仍可读取已有知识/);

  await controller.save(true);
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.equal(changes.at(0).enabled, true);
  assert.match(toggle.closest('label').title, /写入本机/);
});

test('capture control rolls back its visual state when persistence fails', async () => {
  const { document } = parseHTML('<label><input type="checkbox"><i></i></label>');
  const toggle = document.querySelector('input');
  const errors = [];
  const controller = createCaptureControl({
    toggle,
    update: async () => { throw new Error('save failed'); },
    onChange() {},
    onError: (error) => errors.push(error)
  });

  controller.render({ enabled: true });
  await controller.save(false);

  assert.equal(toggle.checked, true);
  assert.equal(errors.at(0).message, 'save failed');
});
