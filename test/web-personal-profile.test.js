import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';

import { mergeKnowledgeGraphs, personalProfileGraph } from '../web/js/knowledge-workspace.js';
import {
  createPersonalProfileView,
  profileKnowledgeItems
} from '../web/js/personal-profile-view.js';

test('personal profile view exposes confirmed and pending preferences as inspectable knowledge', async () => {
  const { document, window } = parseHTML(`
    <button data-profile-aspect="all"></button>
    <button data-profile-aspect="taste"></button>
    <button data-profile-aspect="personality"></button>
    <button data-profile-aspect="judgment_preference"></button>
    <span id="confirmed"></span><span id="observed"></span>
    <button id="conflicts"><strong></strong></button>
    <span id="count"></span><div id="list"></div><div id="empty"></div><aside id="inspector"></aside>
  `);
  globalThis.document = document;
  globalThis.Event = window.Event;
  const ui = {
    personalProfileFilters: [...document.querySelectorAll('[data-profile-aspect]')],
    personalProfileConfirmed: document.querySelector('#confirmed'),
    personalProfileObserved: document.querySelector('#observed'),
    personalProfileConflicts: document.querySelector('#conflicts'),
    personalProfileCount: document.querySelector('#count'),
    personalProfileList: document.querySelector('#list'),
    personalProfileEmpty: document.querySelector('#empty'),
    personalProfileInspector: document.querySelector('#inspector')
  };
  const graph = profileFixture();
  const controller = createPersonalProfileView({
    ui,
    getJson: async () => graph,
    getState: () => ({ activePersonalSpaceId: 'personal-1', personalProjects: [] }),
    editor: { open() {} },
    onError(error) { throw error; }
  });

  await controller.load();

  assert.equal(ui.personalProfileConfirmed.textContent, '1');
  assert.equal(ui.personalProfileObserved.textContent, '1');
  assert.equal(ui.personalProfileConflicts.textContent, '0');
  assert.equal(ui.personalProfileList.children.length, 2);
  assert.deepEqual(
    profileKnowledgeItems(graph).map(({ id }) => id),
    ['judgment', 'prefers']
  );
  ui.personalProfileList.children[0].dispatchEvent(new window.Event('click'));
  assert.match(ui.personalProfileInspector.textContent, /协作偏好|品味|判断偏好/);
  assert.match(ui.personalProfileInspector.textContent, /纠正这条偏好/);

  document.querySelector('[data-profile-aspect="personality"]')
    .dispatchEvent(new window.Event('click'));
  assert.equal(ui.personalProfileList.children.length, 0);
  assert.match(ui.personalProfileEmpty.textContent, /还没有内容/);
  assert.match(ui.personalProfileInspector.textContent, /选择一条偏好或判断/);
});

test('personal project context graph adds only profile items and explicitly selected projects', () => {
  const global = profileFixture();
  const profile = personalProfileGraph(global);
  const active = { space_id: 'personal-1', nodes: [{ id: 'a', name: 'A' }], edges: [] };
  const context = { space_id: 'personal-1', nodes: [{ id: 'b', name: 'B' }], edges: [] };
  const merged = mergeKnowledgeGraphs([active, profile, context]);

  assert.deepEqual(new Set(profile.nodes.map(({ id }) => id)), new Set(['user', 'taste', 'judgment']));
  assert.equal(profile.nodes.some(({ id }) => id === 'project-secret'), false);
  assert.deepEqual(
    new Set(merged.nodes.map(({ id }) => id)),
    new Set(['a', 'b', 'user', 'taste', 'judgment'])
  );
});

test('personal project context applies global preferences plus only that project scope', () => {
  const graph = {
    space_id: 'personal-1',
    nodes: [
      { id: 'global', name: 'Global', type: 'Preference', profile_aspect: 'taste' },
      {
        id: 'a', name: 'A only', type: 'Preference', profile_aspect: 'taste',
        preference_scope: 'project', preference_project_id: 'project-a'
      },
      {
        id: 'b', name: 'B only', type: 'Preference', profile_aspect: 'taste',
        preference_scope: 'project', preference_project_id: 'project-b'
      }
    ],
    edges: []
  };

  assert.deepEqual(
    new Set(personalProfileGraph(graph, 'project-a').nodes.map(({ id }) => id)),
    new Set(['global', 'a'])
  );
});

function profileFixture() {
  return {
    space_id: 'personal-1',
    nodes: [
      { id: 'user', name: '我', type: 'Person', group_id: 'personal', summary: '' },
      {
        id: 'taste', name: '统一交互控件', type: 'DesignTaste', group_id: 'personal',
        summary: '不同性质的按钮不要混放。', profile_aspect: 'taste',
        origin_quadrant: 'known_known',
        confirmation_status: 'confirmed',
        confirmation_basis: {
          existence_reason: '用户明确表达了稳定的界面偏好',
          quadrant_reason: '偏好由用户直接说出，属于已知的已知',
          proposed_by: { kind: 'user', label: '用户' },
          confirmed_by: { kind: 'user', label: '用户' },
          confirmed_at: '2026-07-24T00:00:00Z'
        },
        evidence: []
      },
      {
        id: 'judgment', name: '先做可验证原型', type: 'JudgmentPreference',
        group_id: 'personal', summary: '未知的未知阶段先看结果再校正。',
        profile_aspect: 'judgment_preference', origin_quadrant: 'unknown_known',
        confirmation_status: 'pending',
        confirmation_basis: {
          existence_reason: '从多次选择中提炼出的判断倾向',
          quadrant_reason: '这是从行为中归纳出的隐性知识',
          proposed_by: { kind: 'agent', label: 'Agent' },
          confirmed_by: null,
          confirmed_at: null
        },
        evidence: []
      },
      {
        id: 'project-secret', name: 'B 项目私有知识', type: 'ProjectRule',
        group_id: 'personal', summary: '不应进入画像。', evidence: []
      }
    ],
    edges: [{
      id: 'prefers', source: 'user', target: 'taste', type: 'PREFERS',
      fact: '用户偏好统一的交互控件。', profile_aspect: 'taste',
      origin_quadrant: 'known_known',
      confirmation_status: 'confirmed',
      confirmation_basis: {
        existence_reason: '用户明确表达了稳定的界面偏好',
        quadrant_reason: '偏好由用户直接说出，属于已知的已知',
        proposed_by: { kind: 'user', label: '用户' },
        confirmed_by: { kind: 'user', label: '用户' },
        confirmed_at: '2026-07-24T00:00:00Z'
      },
      evidence: []
    }],
    truncated: false
  };
}
