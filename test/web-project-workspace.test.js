import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  renderPublicProjectCards
} from '../web/js/project-cards.js';
import { renderNodeInspector } from '../web/js/graph-inspector.js';
import { createPublicationDialog } from '../web/js/publication-dialog.js';
import { createProjectManagementDialog } from '../web/js/project-management-dialog.js';

test('public project cards use one clear details label', () => {
  const { document } = parseHTML('<div id="public"></div>');
  globalThis.document = document;
  renderPublicProjectCards(document.querySelector('#public'), {
    projects: [{
      id: 'public-1', providerUrl: 'http://provider.test', name: 'Shared Fuli',
      description: 'Shared context', role: 'maintainer', isOwner: true, can_manage: true,
      current_release: {
        version: 'v1.0.0', summary: 'Initial release', publisher_name: 'Alice',
        published_at: '2026-07-22T08:00:00Z'
      }
    }],
    subscribedKeys: new Set()
  });

  const publicCard = document.querySelector('#public .project-card');
  assert.equal(publicCard.dataset.projectName, 'Shared Fuli');
  assert.equal(publicCard.querySelector('[data-project-action="open"]').textContent, '查看详情');
  assert.equal(publicCard.querySelector('[data-project-action="manage"]').textContent, '管理项目');
  assert.equal(publicCard.querySelector('.project-release-meta strong').textContent, 'v1.0.0');
  assert.equal(publicCard.textContent.includes('已订阅'), false);

  renderPublicProjectCards(document.querySelector('#public'), {
    projects: [{
      id: 'public-1', providerUrl: 'http://provider.test', name: 'Shared Fuli',
      description: 'Shared context', role: 'reader', isOwner: false
    }],
    subscribedKeys: new Set(['http://provider.test::public-1'])
  });
  const subscribedCard = document.querySelector('#public .project-card');
  assert.equal(subscribedCard.textContent.includes('已订阅'), true);
  assert.equal(
    subscribedCard.querySelector('[data-project-action="unsubscribe"]').textContent,
    '取消订阅'
  );
});

test('personal project nodes expose graph-first navigation instead of a project card', () => {
  const { document, window } = parseHTML('<aside id="inspector"></aside>');
  globalThis.document = document;
  let opened = 0;
  renderNodeInspector(document.querySelector('#inspector'), {
    id: 'personal-project:1', name: 'Fuli', type: 'PersonalProject',
    group_id: 'personal', summary: 'Context graph', attributes: { projectId: 'fuli' }
  }, { nodes: [], edges: [] }, {
    onOpenProject: () => { opened += 1; }
  });

  assert.equal(document.querySelector('.inspector-identity code').textContent, 'personal-project:1');
  assert.equal(document.querySelector('.inspector-identity-copy').textContent, '复制');
  const button = [...document.querySelectorAll('button')]
    .find(({ textContent }) => textContent === '进入这个项目');
  assert.equal(button.textContent, '进入这个项目');
  button.dispatchEvent(new window.Event('click'));
  assert.equal(opened, 1);
});

test('publication dialog requires confirmation and exposes progress and success', async () => {
  const { document, window } = parseHTML(`
    <dialog id="dialog">
      <span id="name"></span><input id="version" /><textarea id="summary"></textarea>
      <small id="current"></small><p id="error" hidden></p>
      <button id="cancel"></button><button id="confirm">确认发布</button>
    </dialog>
  `);
  const dialog = document.querySelector('#dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new window.Event('close'));
  };

  let published = null;
  let resolveSuccess;
  const succeeded = new Promise((resolve) => { resolveSuccess = resolve; });
  const controller = createPublicationDialog({
    dialog,
    projectName: document.querySelector('#name'),
    versionInput: document.querySelector('#version'),
    summaryInput: document.querySelector('#summary'),
    currentVersion: document.querySelector('#current'),
    errorMessage: document.querySelector('#error'),
    cancelButton: document.querySelector('#cancel'),
    confirmButton: document.querySelector('#confirm'),
    publish: async (publication) => ({ project: { name: publication.projectName } }),
    onSuccess: async (result, publication) => {
      published = { result, publication };
      resolveSuccess();
    },
    onError: (error) => { throw error; }
  });

  controller.open({
    localProjectId: 'local-1', projectName: 'Fuli',
    currentVersion: 'v1.0.0', suggestedVersion: 'v1.0.1'
  });
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(document.querySelector('#name').textContent, 'Fuli');
  assert.equal(document.querySelector('#version').value, 'v1.0.1');
  assert.match(document.querySelector('#current').textContent, /v1\.0\.0/);

  document.querySelector('#summary').value = 'Record project release history.';

  document.querySelector('#confirm').dispatchEvent(new window.Event('click'));
  assert.equal(document.querySelector('#confirm').textContent, '正在发布…');
  assert.equal(document.querySelector('#confirm').disabled, true);
  await succeeded;

  assert.equal(dialog.hasAttribute('open'), false);
  assert.equal(published.publication.localProjectId, 'local-1');
  assert.equal(published.publication.releaseVersion, 'v1.0.1');
  assert.equal(published.publication.updateSummary, 'Record project release history.');
  assert.equal(published.result.project.name, 'Fuli');
  assert.equal(document.querySelector('#confirm').textContent, '确认发布');
});

test('public project deletion stays in a separate management flow and requires exact name', async () => {
  const { document, window } = parseHTML(`
    <dialog id="dialog"><span id="name"></span><span id="version"></span><span id="role"></span>
      <button id="start"></button><div id="confirmation" hidden>
        <input id="delete-name" /><p id="error" hidden></p>
        <button id="cancel"></button><button id="confirm" disabled></button>
      </div>
    </dialog>
  `);
  const dialog = document.querySelector('#dialog');
  dialog.showModal = () => dialog.setAttribute('open', '');
  dialog.close = () => {
    dialog.removeAttribute('open');
    dialog.dispatchEvent(new window.Event('close'));
  };
  let deleted = null;
  let resolveDeleted;
  const deletion = new Promise((resolve) => { resolveDeleted = resolve; });
  const ui = {
    projectManagementDialog: dialog,
    projectManagementName: document.querySelector('#name'),
    projectManagementVersion: document.querySelector('#version'),
    projectManagementRole: document.querySelector('#role'),
    projectDeleteStart: document.querySelector('#start'),
    projectDeleteConfirmation: document.querySelector('#confirmation'),
    projectDeleteName: document.querySelector('#delete-name'),
    projectDeleteError: document.querySelector('#error'),
    projectDeleteCancel: document.querySelector('#cancel'),
    projectDeleteConfirm: document.querySelector('#confirm')
  };
  const manager = createProjectManagementDialog({
    ui,
    onDelete: async (project) => {
      deleted = project;
      resolveDeleted();
    },
    onError: (error) => { throw error; }
  });
  manager.open({
    id: 'project-1', name: 'Fuli', can_manage: true, isOwner: true,
    role: 'maintainer', current_release: { version: 'v1.0.0' }
  });

  ui.projectDeleteStart.dispatchEvent(new window.Event('click'));
  assert.equal(ui.projectDeleteConfirmation.hidden, false);
  ui.projectDeleteName.value = 'wrong';
  ui.projectDeleteName.dispatchEvent(new window.Event('input'));
  assert.equal(ui.projectDeleteConfirm.disabled, true);
  ui.projectDeleteName.value = 'Fuli';
  ui.projectDeleteName.dispatchEvent(new window.Event('input'));
  assert.equal(ui.projectDeleteConfirm.disabled, false);
  ui.projectDeleteConfirm.dispatchEvent(new window.Event('click'));
  await deletion;
  await Promise.resolve();

  assert.equal(deleted.id, 'project-1');
  assert.equal(dialog.hasAttribute('open'), false);
});
