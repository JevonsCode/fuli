import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { createKnowledgeProjectDialog } from '../web/js/knowledge-project-dialog.js';

test('node project dialog defaults to source relation and defers detected conflicts', async () => {
  const { window, document } = parseHTML(`<!doctype html><html><body>
    <dialog id="dialog"><form id="form">
      <button id="close" type="button"></button><button id="cancel" type="button"></button>
      <span id="source-name"></span><p id="source-summary"></p>
      <label><input id="mode-create" type="radio" name="mode" value="create" checked></label>
      <label><input id="mode-existing" type="radio" name="mode" value="existing"></label>
      <section id="new-fields"><input id="new-name"><input id="new-id"><textarea id="new-purpose"></textarea></section>
      <section id="existing-fields"><select id="target"></select></section>
      <section id="relation-section"><input id="keep-relation" type="checkbox"><select id="relation-type"><option value="RELATED_TO">相关</option></select></section>
      <span id="preview-label"></span><strong id="preview-title"></strong><p id="preview-copy"></p>
      <div id="compare"><strong id="current-name"></strong><p id="current-copy"></p><strong id="match-name"></strong><p id="match-copy"></p></div>
      <fieldset id="conflicts">
        <input type="radio" name="knowledge-conflict-resolution" value="defer" checked>
        <input type="radio" name="knowledge-conflict-resolution" value="keep_target">
        <input type="radio" name="knowledge-conflict-resolution" value="use_source">
        <input type="radio" name="knowledge-conflict-resolution" value="coexist">
      </fieldset>
      <textarea id="reason"></textarea><p id="error"></p>
      <button id="confirm" type="submit"></button>
    </form></dialog>
  </body></html>`);
  globalThis.document = document;
  globalThis.Event = window.Event;
  const dialog = document.querySelector('#dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => dialog.removeAttribute('open');
  Object.defineProperty(dialog, 'open', {
    get: () => dialog.hasAttribute('open')
  });
  const ui = elements(document, dialog);
  const previews = [];
  const applications = [];
  let success = null;
  const controller = createKnowledgeProjectDialog({
    ui,
    preview: async (input) => {
      previews.push(input);
      return {
        item_name: '发布规则',
        item_summary: '必须审核',
        match: {
          kind: 'conflict',
          reason: '同名内容不同',
          item_name: '发布规则',
          item_summary: '可以直接发布'
        }
      };
    },
    apply: async (input) => {
      applications.push(input);
      return { status: 'conflict_pending' };
    },
    onSuccess: async (result, targetName) => {
      success = { result, targetName };
    }
  });

  controller.open({
    id: 'entity-1',
    itemKind: 'entity',
    assignments: [{ project_id: 'project-b' }],
    evidence: [],
    raw: { name: '发布规则', summary: '必须审核' }
  }, {
    personalSpaceId: 'personal-1',
    personalProjectId: 'project-b',
    projects: [
      { project_id: 'project-a', profile: { name: 'A 项目' } },
      { project_id: 'project-b', profile: { name: 'B 项目' } }
    ]
  });

  assert.equal(ui.knowledgeProjectKeepRelation.checked, true);
  assert.equal(ui.knowledgeProjectTarget.options.length, 1);
  assert.equal(ui.knowledgeProjectTarget.options[0].value, 'project-a');
  ui.knowledgeProjectModeCreate.checked = false;
  ui.knowledgeProjectModeExisting.checked = true;
  assert.equal(ui.knowledgeProjectModeExisting.checked, true);
  ui.knowledgeProjectModeExisting.dispatchEvent(new window.Event('change'));
  await tick();

  assert.equal(previews[0].targetProjectId, 'project-a');
  assert.equal(ui.knowledgeProjectConflictOptions.hidden, false);
  ui.knowledgeProjectForm.dispatchEvent(new window.Event('submit', {
    bubbles: true,
    cancelable: true
  }));
  await tick();

  assert.equal(applications[0].keepSourceRelation, true);
  assert.equal(applications[0].conflictResolution, 'defer');
  assert.equal(applications[0].targetProjectId, 'project-a');
  assert.deepEqual(success, {
    result: { status: 'conflict_pending' },
    targetName: 'A 项目'
  });
});

function elements(document, dialog) {
  const get = (id) => document.querySelector(`#${id}`);
  return {
    knowledgeProjectDialog: dialog,
    knowledgeProjectClose: get('close'),
    knowledgeProjectCancel: get('cancel'),
    knowledgeProjectForm: get('form'),
    knowledgeProjectSourceName: get('source-name'),
    knowledgeProjectSourceSummary: get('source-summary'),
    knowledgeProjectModeCreate: get('mode-create'),
    knowledgeProjectModeExisting: get('mode-existing'),
    knowledgeProjectNewFields: get('new-fields'),
    knowledgeProjectExistingFields: get('existing-fields'),
    knowledgeProjectNewName: get('new-name'),
    knowledgeProjectNewId: get('new-id'),
    knowledgeProjectNewPurpose: get('new-purpose'),
    knowledgeProjectTarget: get('target'),
    knowledgeProjectRelationSection: get('relation-section'),
    knowledgeProjectKeepRelation: get('keep-relation'),
    knowledgeProjectRelationType: get('relation-type'),
    knowledgeProjectPreviewLabel: get('preview-label'),
    knowledgeProjectPreviewTitle: get('preview-title'),
    knowledgeProjectPreviewCopy: get('preview-copy'),
    knowledgeProjectCompare: get('compare'),
    knowledgeProjectCurrentName: get('current-name'),
    knowledgeProjectCurrentCopy: get('current-copy'),
    knowledgeProjectMatchName: get('match-name'),
    knowledgeProjectMatchCopy: get('match-copy'),
    knowledgeProjectConflictOptions: get('conflicts'),
    knowledgeProjectReason: get('reason'),
    knowledgeProjectError: get('error'),
    knowledgeProjectConfirm: get('confirm')
  };
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
