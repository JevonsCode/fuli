import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createRelationComposer } from '../web/js/relation-composer.js';

test('relation composer builds a reviewed hierarchy relation from a visual flow', async () => {
  const { document, window } = parseHTML(`
    <button id="add" aria-expanded="false"></button>
    <div id="composer" hidden>
      <form id="form">
        <select id="source"></select>
        <input id="search" />
        <div id="targets"></div>
        <input id="part-of" type="radio" name="relation-type" value="PART_OF" />
        <input type="radio" name="relation-type" value="RELATED_TO" />
        <strong id="preview-source"></strong>
        <strong id="preview-type"></strong>
        <strong id="preview-target"></strong>
        <p id="rule"></p><p id="validation" hidden></p>
        <button id="cancel" type="button"></button>
        <button id="submit" type="submit"></button>
      </form>
    </div>
  `);
  globalThis.document = document;
  const ui = {
    relationAddButton: document.querySelector('#add'),
    relationComposer: document.querySelector('#composer'),
    projectRelationForm: document.querySelector('#form'),
    relationSource: document.querySelector('#source'),
    relationTargetSearch: document.querySelector('#search'),
    relationTargetList: document.querySelector('#targets'),
    relationPreviewSource: document.querySelector('#preview-source'),
    relationPreviewType: document.querySelector('#preview-type'),
    relationPreviewTarget: document.querySelector('#preview-target'),
    relationRule: document.querySelector('#rule'),
    relationValidation: document.querySelector('#validation'),
    relationCancelButton: document.querySelector('#cancel'),
    relationSubmitButton: document.querySelector('#submit')
  };

  let submitted;
  let resolveSubmitted;
  const submission = new Promise((resolve) => { resolveSubmitted = resolve; });
  const composer = createRelationComposer({
    ui,
    onSubmit: async (value) => {
      submitted = value;
      resolveSubmitted();
    },
    onError: (error) => { throw error; }
  });
  composer.configure([
    {
      id: 'hotel', providerUrl: 'http://provider.test', name: '酒店主题',
      purpose: '酒店活动主题', role: 'maintainer'
    },
    {
      id: 'activity', providerUrl: 'http://provider.test', name: '活动承接',
      purpose: '活动承接产品域', role: 'reader'
    },
    {
      id: 'other', providerUrl: 'http://other.test', name: '其他空间',
      purpose: '另一个 Provider', role: 'maintainer'
    }
  ]);

  composer.open();
  assert.equal(ui.relationComposer.hidden, false);
  assert.equal(ui.relationPreviewSource.textContent, '酒店主题');
  assert.equal(ui.relationTargetList.querySelectorAll('input').length, 1);
  assert.equal(ui.relationTargetList.textContent.includes('活动承接'), true);
  assert.equal(ui.relationTargetList.textContent.includes('其他空间'), false);

  const type = document.querySelector('#part-of');
  type.checked = true;
  type.dispatchEvent(new window.Event('change', { bubbles: true }));
  const target = ui.relationTargetList.querySelector('input');
  target.checked = true;
  target.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.equal(ui.relationPreviewType.textContent, '属于');
  assert.equal(ui.relationPreviewTarget.textContent, '活动承接');
  assert.match(ui.relationRule.textContent, /等待 “活动承接” Maintainer 确认/);

  ui.projectRelationForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await submission;
  await Promise.resolve();
  assert.equal(submitted.source.id, 'hotel');
  assert.equal(submitted.target.id, 'activity');
  assert.equal(submitted.relationType, 'PART_OF');
  assert.equal(ui.relationComposer.hidden, true);
});

test('relation composer filters targets and explains incomplete input', () => {
  const { document, window } = parseHTML(`
    <button id="add"></button><div id="composer" hidden><form id="form">
      <select id="source"></select><input id="search" /><div id="targets"></div>
      <input type="radio" name="relation-type" value="RELATED_TO" />
      <span id="preview-source"></span><span id="preview-type"></span><span id="preview-target"></span>
      <p id="rule"></p><p id="validation" hidden></p>
      <button id="cancel" type="button"></button><button id="submit" type="submit"></button>
    </form></div>
  `);
  globalThis.document = document;
  const byId = (id) => document.querySelector(`#${id}`);
  const ui = {
    relationAddButton: byId('add'), relationComposer: byId('composer'),
    projectRelationForm: byId('form'), relationSource: byId('source'),
    relationTargetSearch: byId('search'), relationTargetList: byId('targets'),
    relationPreviewSource: byId('preview-source'), relationPreviewType: byId('preview-type'),
    relationPreviewTarget: byId('preview-target'), relationRule: byId('rule'),
    relationValidation: byId('validation'), relationCancelButton: byId('cancel'),
    relationSubmitButton: byId('submit')
  };
  const composer = createRelationComposer({ ui, onSubmit: async () => {}, onError: () => {} });
  composer.configure([
    { id: 'a', providerUrl: 'one', name: 'A', role: 'maintainer' },
    { id: 'b', providerUrl: 'one', name: '酒店主题', role: 'reader' },
    { id: 'c', providerUrl: 'one', name: '机票业务', role: 'reader' }
  ]);
  composer.open();

  ui.relationTargetSearch.value = '机票';
  ui.relationTargetSearch.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(ui.relationTargetList.querySelectorAll('input').length, 1);
  assert.match(ui.relationTargetList.textContent, /机票业务/);

  ui.projectRelationForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ui.relationValidation.hidden, false);
  assert.equal(ui.relationValidation.textContent, '请选择一种项目关系。');
});
