import assert from 'node:assert/strict';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import {
  readGraphRuntimeConfig,
  resolveGraphRuntimeOptions
} from '../src/graphiti/runtime-config.js';

// 英文内容仅保留给接口枚举、稳定标识和检索标记；所有供人工检查的用例文案均为中文。
const FIXTURE_SPACE_NAME = 'Fuli Knowledge Acceptance Fixture';
const FIXTURE_SPACE_DISPLAY_NAME = 'Fuli 知识验收隔离空间';
const FIXTURE_VERSION = 'v7';
const REFERENCE_TIME = '2026-07-30T00:00:00.000Z';
const PROJECTS = Object.freeze({
  parent: 'acceptance-parent',
  child: 'acceptance-child',
  sibling: 'acceptance-sibling',
  grandchild: 'acceptance-grandchild',
  greatGrandchild: 'acceptance-great-grandchild',
  related: 'acceptance-related'
});
const KEYS = Object.freeze({
  childAnchor: 'acceptance:child-anchor',
  siblingAnchor: 'acceptance:sibling-anchor',
  grandchildAnchor: 'acceptance:grandchild-anchor',
  greatGrandchildAnchor: 'acceptance:great-grandchild-anchor',
  inheritedPending: 'acceptance:inherited-pending',
  localOnly: 'acceptance:local-only',
  selectedChild: 'acceptance:selected-child',
  relatedOnly: 'acceptance:related-only',
  localOverride: 'acceptance:local-override',
  authorityHuman: 'acceptance:authority-human',
  conflictBlocked: 'acceptance:conflict-blocked',
  conflictTarget: 'acceptance:conflict-target',
  globalPreference: 'acceptance:preference:global',
  pendingAgentPreference: 'acceptance:preference:agent',
  parentHumanPreference: 'acceptance:preference:parent-human',
  quadrantKnownKnown: 'acceptance:quadrant:known-known',
  quadrantKnownUnknown: 'acceptance:quadrant:known-unknown',
  quadrantUnknownKnown: 'acceptance:quadrant:unknown-known',
  quadrantUnknownUnknown: 'acceptance:quadrant:unknown-unknown'
});

const startedAt = Date.now();
const { runtimeConfigPath } = resolveGraphRuntimeOptions(process.argv.slice(2));
const runtimeConfig = readGraphRuntimeConfig(runtimeConfigPath);
const provider = new GraphitiProviderClient({
  baseUrl: runtimeConfig.personal.providerUrl,
  accessToken: runtimeConfig.personal.accessToken
});
const fixtureSpace = await findOrCreateFixtureSpace(provider);
const app = new FederatedGraphApplication({
  version: 1,
  personal: {
    ...runtimeConfig.personal,
    spaceId: fixtureSpace.id
  },
  workspaces: []
});

try {
  const fixture = await ensureBaseFixture(app, fixtureSpace.id);
  const cases = [];
  const metrics = {};
  await resetPendingEntity(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.inheritedPending,
    '父项目部署知识处于待确认状态，包含 acceptance-inheritance-marker ' +
      '和 acceptance-authority-marker。'
  );
  await resetPendingEntity(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-block-marker 冲突来源值'
  );
  await resetPendingEntity(
    app,
    fixtureSpace.id,
    null,
    fixture.ids.pendingAgentPreference,
    '只有达到有效使用条件后，才启用智能体已确认的验收兜底偏好。'
  );
  const quadrantFixtures = [
    [fixture.ids.quadrantKnownKnown, 'known_known'],
    [fixture.ids.quadrantKnownUnknown, 'known_unknown'],
    [fixture.ids.quadrantUnknownKnown, 'unknown_known'],
    [fixture.ids.quadrantUnknownUnknown, 'unknown_unknown']
  ];
  for (const [itemId, quadrant] of quadrantFixtures) {
    await ensureConfirmedClassification(
      app,
      fixtureSpace.id,
      PROJECTS.parent,
      itemId,
      quadrant
    );
  }

  const searchable = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.child,
    query: 'acceptance-inheritance-marker',
    includePending: true
  });
  const inherited = searchable.entities.find(
    ({ id }) => id === fixture.ids.inheritedPending
  );
  assert.ok(inherited, '子项目应能检索到父项目的待确认知识');
  assert.equal(inherited.confirmation_status, 'pending');
  assert.equal(inherited.defined_project_id, PROJECTS.parent);
  assert.equal(inherited.inherited_from_project_id, PROJECTS.parent);
  assert.equal(inherited.scope_distance, 1);
  assert.deepEqual(searchable.searchedPersonalProjectIds, [PROJECTS.child]);

  const confirmedOnly = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.child,
    query: 'acceptance-inheritance-marker',
    includePending: false
  });
  assert.equal(
    confirmedOnly.entities.some(({ id }) => id === fixture.ids.inheritedPending),
    false,
    '仅检索已确认知识时，必须排除待确认知识'
  );
  cases.push({
    id: 'KAC-01',
    title: '待确认父项目知识按显式继承进入子项目检索',
    status: '通过'
  });

  const quadrantSearch = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.parent,
    query: 'acceptance-quadrant-marker',
    includePending: true
  });
  const quadrantItems = quadrantSearch.entities.filter(
    ({ key }) => key?.startsWith('acceptance:quadrant:')
  );
  assert.equal(quadrantItems.length, 4);
  assert.deepEqual(
    new Set(quadrantItems.map(({ origin_quadrant: quadrant }) => quadrant)),
    new Set([
      'known_known',
      'known_unknown',
      'unknown_known',
      'unknown_unknown'
    ])
  );
  assert.equal(
    new Set(quadrantItems.map(({ score }) => score)).size,
    1,
    '原始象限不能影响个人知识的检索排序'
  );

  await assert.rejects(
    app.reviseKnowledgeItem({
      personalSpaceId: fixtureSpace.id,
      personalProjectId: PROJECTS.parent,
      itemKind: 'entity',
      itemId: fixture.ids.quadrantUnknownKnown,
      action: 'update',
      reason: '反向验收：验证知识形成时的发现来源不可修改。',
      originQuadrant: 'known_known',
      operationActor: 'agent'
    }),
    (error) => (
      error?.status === 422 &&
      String(error?.details?.detail).includes('origin quadrant is immutable')
    )
  );
  await app.reviseKnowledgeItem({
    personalSpaceId: fixtureSpace.id,
    personalProjectId: PROJECTS.parent,
    itemKind: 'entity',
    itemId: fixture.ids.quadrantUnknownKnown,
    action: 'update',
    reason: '验收操作只调整当前象限，不改变原始象限。',
    currentQuadrant: 'known_known',
    operationActor: 'agent'
  });
  const reclassified = await graphNode(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.quadrantUnknownKnown
  );
  assert.equal(reclassified.origin_quadrant, 'unknown_known');
  assert.equal(reclassified.current_quadrant, 'known_known');
  assert.equal(reclassified.confirmation_status, 'pending');
  cases.push({
    id: 'KAC-08',
    title: '四象限只记录发现来源，不参与排序；原始象限不可变',
    status: '通过'
  });

  const childPreferencesBefore = await app.getCollaborationPreferences({
    personalSpaceId: fixtureSpace.id,
    personalProjectId: PROJECTS.child
  });
  const childKeysBefore = childPreferencesBefore.effective_preferences.map(
    ({ preference_key: preferenceKey }) => preferenceKey
  );
  assert.ok(childKeysBefore.includes('acceptance.preference.global'));
  assert.equal(childKeysBefore.includes('acceptance.preference.override'), false);
  const pendingPreferenceBefore = await graphNode(
    app,
    fixtureSpace.id,
    null,
    fixture.ids.pendingAgentPreference
  );
  assert.equal(pendingPreferenceBefore.confirmation_status, 'pending');
  assert.equal(pendingPreferenceBefore.qualified_use_count, 0);

  const parentPreferencesBefore = await app.getCollaborationPreferences({
    personalSpaceId: fixtureSpace.id,
    personalProjectId: PROJECTS.parent
  });
  const parentHuman = parentPreferencesBefore.effective_preferences.find(
    ({ id }) => id === fixture.ids.parentHumanPreference
  );
  assert.ok(parentHuman, '父项目应获得仅属于自身的精确项目偏好');
  assert.equal(parentHuman.confirmation_status, 'confirmed');

  const promotedPreference = await recordFiveUses(
    app,
    fixtureSpace.id,
    fixture.ids.pendingAgentPreference,
    'acceptance-preference-task'
  );
  assert.equal(promotedPreference.confirmation_status, 'agent_confirmed');

  const childPreferencesAfter = await app.getCollaborationPreferences({
    personalSpaceId: fixtureSpace.id,
    personalProjectId: PROJECTS.child
  });
  const childAgentPreference = childPreferencesAfter.effective_preferences.find(
    ({ id }) => id === fixture.ids.pendingAgentPreference
  );
  assert.ok(childAgentPreference);
  assert.equal(childAgentPreference.confirmation_status, 'agent_confirmed');
  assert.equal(
    childPreferencesAfter.effective_preferences.some(
      ({ id }) => id === fixture.ids.parentHumanPreference
    ),
    false,
    '父项目偏好不得继承到子项目'
  );

  const parentPreferencesAfter = await app.getCollaborationPreferences({
    personalSpaceId: fixtureSpace.id,
    personalProjectId: PROJECTS.parent
  });
  const parentOverride = parentPreferencesAfter.effective_preferences.find(
    ({ preference_key: preferenceKey }) =>
      preferenceKey === 'acceptance.preference.override'
  );
  assert.equal(parentOverride.id, fixture.ids.parentHumanPreference);
  assert.equal(parentOverride.confirmation_status, 'confirmed');
  assert.ok(
    parentPreferencesAfter.overridden_global_ids.includes(
      fixture.ids.pendingAgentPreference
    )
  );

  await assert.rejects(
    app.captureSessionKnowledge({
      targetKind: 'personal',
      spaceId: fixtureSpace.id,
      personalProjectId: PROJECTS.parent,
      idempotencyKey: `${FIXTURE_VERSION}:invalid-inheritable-preference`,
      sessionId: `knowledge-acceptance-${FIXTURE_VERSION}`,
      name: '无效的可继承偏好反向验收',
      sourceKind: 'acceptance_test',
      sourceDescription: '反向验收：校验层必须在写入前拒绝该数据。',
      sourceApplication: 'codex',
      referenceTime: REFERENCE_TIME,
      sensitivity: 'private',
      entities: [entity({
        key: 'acceptance:invalid-inheritable-preference',
        name: '不得继承的项目偏好',
        summary: '这条无效偏好绝对不能写入图数据库。',
        status: 'confirmed',
        profileAspect: 'taste',
        inheritanceMode: 'descendants'
      })],
      relationships: []
    }),
    (error) => (
      error?.status === 422 &&
      JSON.stringify(error?.details).includes(
        'personal preferences cannot inherit across projects'
      )
    )
  );
  cases.push({
    id: 'KAC-07',
    title: '偏好按全局与精确项目注入，待确认和智能体已确认遵守不同门槛与权重',
    status: '通过'
  });

  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-task-1',
    'cited'
  );
  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-task-1',
    'applied'
  );
  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-task-2',
    'cited'
  );
  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-task-2',
    'applied'
  );
  const blockedUse = await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.conflictBlocked,
    'acceptance-conflict-task-3',
    'cited'
  );
  assert.equal(blockedUse.items[0].qualified_use_count, 5);
  assert.equal(blockedUse.items[0].distinct_task_count, 3);
  assert.equal(blockedUse.items[0].promoted, false);
  assert.equal(blockedUse.items[0].confirmation_status, 'pending');
  cases.push({
    id: 'KAC-06',
    title: '存在待处理冲突时，重复使用不能把待确认知识强化为事实',
    status: '通过'
  });

  const firstUse = await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-1',
    'cited'
  );
  assert.equal(firstUse.recorded_count, 1);
  const duplicateUse = await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-1',
    'cited'
  );
  assert.equal(duplicateUse.recorded_count, 0);
  assert.equal(duplicateUse.duplicate_count, 1);
  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-1',
    'applied'
  );
  await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-2',
    'cited'
  );
  const fourthUse = await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-2',
    'applied'
  );
  assert.equal(fourthUse.items[0].qualified_use_count, 4);
  assert.equal(fourthUse.items[0].distinct_task_count, 2);
  assert.equal(fourthUse.items[0].confirmation_status, 'pending');

  const fifthUse = await recordUse(
    app,
    fixtureSpace.id,
    fixture.ids.inheritedPending,
    'acceptance-task-3',
    'cited'
  );
  const promoted = fifthUse.items[0];
  assert.equal(promoted.qualified_use_count, 5);
  assert.equal(promoted.distinct_task_count, 3);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.confirmation_status, 'agent_confirmed');
  assert.ok(promoted.utility_score > 0);
  assert.ok(promoted.confidence_score > 0.5);
  assert.ok(promoted.confidence_score <= 0.85);
  cases.push({
    id: 'KAC-04',
    title: '有效使用按任务幂等计数，并在 5 次且跨 3 个任务时晋级智能体已确认',
    status: '通过'
  });

  const authoritySearch = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.parent,
    query: 'acceptance-authority-marker',
    includePending: true
  });
  const authorityIds = authoritySearch.entities.map(({ id }) => id);
  const humanIndex = authorityIds.indexOf(fixture.ids.authorityHuman);
  const agentIndex = authorityIds.indexOf(fixture.ids.inheritedPending);
  assert.ok(humanIndex >= 0 && agentIndex >= 0);
  assert.ok(humanIndex < agentIndex, '人工确认知识应排在智能体已确认知识之前');

  const beforeReset = await graphNode(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.inheritedPending
  );
  await resetPendingEntity(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.inheritedPending,
    '父项目部署知识处于待确认状态，包含 acceptance-inheritance-marker ' +
      '和 acceptance-authority-marker。'
  );
  const afterReset = await graphNode(
    app,
    fixtureSpace.id,
    PROJECTS.parent,
    fixture.ids.inheritedPending
  );
  assert.equal(afterReset.confirmation_status, 'pending');
  assert.equal(afterReset.usage_generation, beforeReset.usage_generation + 1);
  assert.equal(afterReset.qualified_use_count, 0);
  assert.equal(afterReset.distinct_task_count, 0);
  assert.equal(afterReset.utility_score, 0);
  assert.equal(afterReset.confidence_score, 0.5);
  cases.push({
    id: 'KAC-05',
    title: '人工确认高于智能体已确认，内容修改会重置确认代次与双分数',
    status: '通过'
  });

  const overrideScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.child,
    query: 'acceptance-local-override-marker',
    includePending: true
  });
  const overrides = overrideScope.entities.filter(
    ({ key }) => key === KEYS.localOverride
  );
  assert.equal(overrides.length, 1, '同一个稳定键只能产生一条最终生效知识');
  assert.equal(overrides[0].id, fixture.ids.childOverride);
  assert.equal(overrides[0].defined_project_id, PROJECTS.child);
  assert.equal(overrides[0].inherited_from_project_id, null);
  assert.equal(overrides[0].scope_distance, 0);
  assert.match(overrides[0].summary, /child-local-value/);
  cases.push({
    id: 'KAC-03',
    title: '当前项目中相同稳定键的本地知识覆盖父级继承项',
    status: '通过'
  });

  const childScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.child,
    query: 'acceptance-selective-inheritance-marker',
    includePending: true
  });
  assert.equal(
    childScope.entities.some(({ id }) => id === fixture.ids.localOnly),
    false,
    '仅限本项目的父项目知识不得进入子项目检索结果'
  );
  assert.ok(
    childScope.entities.some(({ id }) => id === fixture.ids.selectedChild),
    '指定项目可继承的知识应进入被选中的子项目'
  );

  const siblingScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.sibling,
    query: 'acceptance-selected-child-marker',
    includePending: true
  });
  assert.equal(
    siblingScope.entities.some(({ id }) => id === fixture.ids.selectedChild),
    false,
    '指定项目可继承的知识不得进入未被选中的兄弟项目'
  );

  const grandchildScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.grandchild,
    query: 'acceptance-inheritance-marker',
    includePending: true
  });
  const twoHop = grandchildScope.entities.find(
    ({ id }) => id === fixture.ids.inheritedPending
  );
  assert.ok(twoHop, '两跳以内的后代项目应能检索可继承的父项目知识');
  assert.equal(twoHop.scope_distance, 2);

  const greatGrandchildScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.greatGrandchild,
    query: 'acceptance-inheritance-marker',
    includePending: true
  });
  assert.equal(
    greatGrandchildScope.entities.some(({ id }) => id === fixture.ids.inheritedPending),
    false,
    '知识继承必须在两跳后停止'
  );

  const relatedScope = await search(app, fixtureSpace.id, {
    projectId: PROJECTS.child,
    query: 'acceptance-related-only-marker',
    includePending: true
  });
  assert.equal(
    relatedScope.entities.some(({ id }) => id === fixture.ids.relatedOnly),
    false,
    'RELATED_TO 关系不得扩张检索作用域'
  );
  cases.push({
    id: 'KAC-02',
    title: '继承模式、两跳上限与关系白名单共同限制跨项目检索',
    status: '通过'
  });

  const searchDurations = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const searchStartedAt = Date.now();
    const result = await search(app, fixtureSpace.id, {
      projectId: PROJECTS.child,
      query: 'acceptance-selected-child-marker',
      includePending: true
    });
    searchDurations.push(Date.now() - searchStartedAt);
    assert.deepEqual(result.searchedPersonalProjectIds, [PROJECTS.child]);
  }
  const orderedDurations = [...searchDurations].sort((left, right) => left - right);
  const percentile = (value) => orderedDurations[
    Math.min(
      orderedDurations.length - 1,
      Math.ceil(orderedDurations.length * value) - 1
    )
  ];
  metrics.boundedProjectSearch = {
    samples: orderedDurations.length,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maxMs: orderedDurations.at(-1)
  };
  assert.ok(
    metrics.boundedProjectSearch.p95Ms < 2000,
    '有界的本地项目检索 p95 必须低于实时故障预算'
  );
  cases.push({
    id: 'KAC-09',
    title: '智能体可见的项目检索保持有界，并满足本机实时查询故障预算',
    status: '通过'
  });

  process.stdout.write(`${JSON.stringify({
    status: '通过',
    fixtureSpace: {
      id: fixtureSpace.id,
      name: FIXTURE_SPACE_DISPLAY_NAME,
      technicalName: fixtureSpace.name
    },
    cases: cases.sort((left, right) => left.id.localeCompare(right.id)),
    metrics,
    durationMs: Date.now() - startedAt
  }, null, 2)}\n`);
} finally {
  app.close();
}

async function findOrCreateFixtureSpace(client) {
  const spaces = await client.listSpaces();
  const existing = spaces.find(
    ({ kind, name }) => kind === 'personal' && name === FIXTURE_SPACE_NAME
  );
  if (existing) return existing;
  return client.createSpace({
    name: FIXTURE_SPACE_NAME,
    kind: 'personal',
    description: '供 Fuli 知识验收场景重复使用的隔离个人空间。'
  });
}

async function ensureBaseFixture(application, personalSpaceId) {
  await Promise.all([
    upsertProject(application, personalSpaceId, PROJECTS.parent, '验收父项目'),
    upsertProject(application, personalSpaceId, PROJECTS.child, '验收子项目'),
    upsertProject(application, personalSpaceId, PROJECTS.sibling, '验收兄弟项目'),
    upsertProject(application, personalSpaceId, PROJECTS.grandchild, '验收孙级项目'),
    upsertProject(
      application,
      personalSpaceId,
      PROJECTS.greatGrandchild,
      '验收曾孙级项目'
    ),
    upsertProject(application, personalSpaceId, PROJECTS.related, '验收普通关联项目')
  ]);

  const child = await captureEntities(application, personalSpaceId, PROJECTS.child, [
    entity({
      key: KEYS.childAnchor,
      name: '验收子项目关系锚点',
      summary: '仅用于创建有方向项目关系的稳定子项目锚点。',
      status: 'confirmed'
    }),
    entity({
      key: KEYS.localOverride,
      name: '验收本地覆盖知识',
      summary: 'acceptance-local-override-marker 子项目本地值',
      status: 'confirmed'
    }),
    entity({
      key: KEYS.conflictTarget,
      name: '验收冲突部署规则',
      summary: 'acceptance-conflict-block-marker 冲突目标值',
      status: 'confirmed'
    })
  ]);
  const sibling = await captureEntities(application, personalSpaceId, PROJECTS.sibling, [
    relationAnchor(KEYS.siblingAnchor, '验收兄弟项目关系锚点')
  ]);
  const grandchild = await captureEntities(
    application,
    personalSpaceId,
    PROJECTS.grandchild,
    [relationAnchor(KEYS.grandchildAnchor, '验收孙级项目关系锚点')]
  );
  const greatGrandchild = await captureEntities(
    application,
    personalSpaceId,
    PROJECTS.greatGrandchild,
    [relationAnchor(
      KEYS.greatGrandchildAnchor,
      '验收曾孙级项目关系锚点'
    )]
  );
  const parent = await captureEntities(application, personalSpaceId, PROJECTS.parent, [
    entity({
      key: KEYS.inheritedPending,
      name: '验收待确认的可继承部署知识',
      summary: '父项目部署知识处于待确认状态，并包含 ' +
        'acceptance-inheritance-marker 和 acceptance-authority-marker。',
      status: 'pending',
      inheritanceMode: 'descendants'
    }),
    entity({
      key: KEYS.localOnly,
      name: '验收仅限父项目的知识',
      summary: 'acceptance-selective-inheritance-marker 父项目本地专用标记',
      status: 'confirmed'
    }),
    entity({
      key: KEYS.selectedChild,
      name: '验收仅向指定子项目继承的知识',
      summary: 'acceptance-selective-inheritance-marker acceptance-selected-child-marker',
      status: 'confirmed',
      inheritanceMode: 'selected_projects',
      inheritedProjectIds: [PROJECTS.child]
    }),
    entity({
      key: KEYS.localOverride,
      name: '验收本地覆盖知识',
      summary: 'acceptance-local-override-marker 从父项目继承的值',
      status: 'confirmed',
      inheritanceMode: 'descendants'
    }),
    entity({
      key: KEYS.authorityHuman,
      name: '验收人工确认权威知识',
      summary: 'acceptance-authority-marker 人工确认值',
      status: 'confirmed'
    }),
    entity({
      key: KEYS.conflictBlocked,
      name: '验收冲突部署规则',
      summary: 'acceptance-conflict-block-marker 冲突来源值',
      status: 'confirmed'
    }),
    entity({
      key: KEYS.parentHumanPreference,
      name: '验收父项目人工确认偏好',
      summary: '使用经过人工确认、且仅属于父项目的验收规则。',
      status: 'confirmed',
      profileAspect: 'judgment_preference',
      attributes: {
        preferenceKey: 'acceptance.preference.override'
      }
    }),
    quadrantEntity(KEYS.quadrantKnownKnown, 'known_known'),
    quadrantEntity(KEYS.quadrantKnownUnknown, 'known_unknown'),
    quadrantEntity(KEYS.quadrantUnknownKnown, 'unknown_known'),
    quadrantEntity(KEYS.quadrantUnknownUnknown, 'unknown_unknown')
  ]);
  const related = await captureEntities(application, personalSpaceId, PROJECTS.related, [
    entity({
      key: KEYS.relatedOnly,
      name: '验收普通关联项目知识',
      summary: 'acceptance-related-only-marker',
      status: 'confirmed',
      inheritanceMode: 'descendants'
    })
  ]);
  const global = await captureEntities(application, personalSpaceId, null, [
    entity({
      key: KEYS.globalPreference,
      name: '验收全局偏好',
      summary: '应用已经人工确认的全局验收规则。',
      status: 'confirmed',
      profileAspect: 'taste',
      attributes: {
        preferenceKey: 'acceptance.preference.global'
      }
    }),
    entity({
      key: KEYS.pendingAgentPreference,
      name: '验收待确认的智能体偏好',
      summary: '只有达到有效使用条件后，才启用智能体已确认的验收兜底偏好。',
      status: 'pending',
      profileAspect: 'judgment_preference',
      attributes: {
        preferenceKey: 'acceptance.preference.override'
      }
    })
  ]);

  await Promise.all([
    ensureRelation(
      application,
      personalSpaceId,
      child.ids[KEYS.childAnchor],
      PROJECTS.parent,
      'PART_OF'
    ),
    ensureRelation(
      application,
      personalSpaceId,
      sibling.ids[KEYS.siblingAnchor],
      PROJECTS.parent,
      'PART_OF'
    ),
    ensureRelation(
      application,
      personalSpaceId,
      grandchild.ids[KEYS.grandchildAnchor],
      PROJECTS.child,
      'PART_OF'
    ),
    ensureRelation(
      application,
      personalSpaceId,
      greatGrandchild.ids[KEYS.greatGrandchildAnchor],
      PROJECTS.grandchild,
      'PART_OF'
    ),
    ensureRelation(
      application,
      personalSpaceId,
      child.ids[KEYS.childAnchor],
      PROJECTS.related,
      'RELATED_TO'
    )
  ]);
  await ensurePendingConflict(
    application,
    personalSpaceId,
    parent.ids[KEYS.conflictBlocked],
    PROJECTS.child
  );

  return {
    ids: {
      childAnchor: child.ids[KEYS.childAnchor],
      inheritedPending: parent.ids[KEYS.inheritedPending],
      localOnly: parent.ids[KEYS.localOnly],
      selectedChild: parent.ids[KEYS.selectedChild],
      relatedOnly: related.ids[KEYS.relatedOnly],
      parentOverride: parent.ids[KEYS.localOverride],
      childOverride: child.ids[KEYS.localOverride],
      authorityHuman: parent.ids[KEYS.authorityHuman],
      conflictBlocked: parent.ids[KEYS.conflictBlocked],
      conflictTarget: child.ids[KEYS.conflictTarget],
      globalPreference: global.ids[KEYS.globalPreference],
      pendingAgentPreference: global.ids[KEYS.pendingAgentPreference],
      parentHumanPreference: parent.ids[KEYS.parentHumanPreference],
      quadrantKnownKnown: parent.ids[KEYS.quadrantKnownKnown],
      quadrantKnownUnknown: parent.ids[KEYS.quadrantKnownUnknown],
      quadrantUnknownKnown: parent.ids[KEYS.quadrantUnknownKnown],
      quadrantUnknownUnknown: parent.ids[KEYS.quadrantUnknownUnknown]
    }
  };
}

function relationAnchor(key, name) {
  return entity({
    key,
    name,
    summary: '仅用于创建有方向项目关系的稳定验收锚点。',
    status: 'confirmed'
  });
}

function quadrantEntity(key, originQuadrant) {
  return entity({
    key,
    name: `验收象限 ${originQuadrant}`,
    summary: 'acceptance-quadrant-marker',
    status: 'confirmed',
    originQuadrant
  });
}

function ensureRelation(
  application,
  personalSpaceId,
  sourceItemId,
  targetProjectId,
  relationType
) {
  return application.applyKnowledgeProjectAction({
    personalSpaceId,
    itemKind: 'entity',
    itemId: sourceItemId,
    mode: 'existing',
    targetProjectId,
    keepSourceRelation: true,
    relationType,
    conflictResolution: 'coexist',
    reason: `验收数据创建一条明确的 ${relationType} 项目关系。`,
    operationActor: 'agent'
  });
}

function ensurePendingConflict(
  application,
  personalSpaceId,
  sourceItemId,
  targetProjectId
) {
  return application.applyKnowledgeProjectAction({
    personalSpaceId,
    itemKind: 'entity',
    itemId: sourceItemId,
    mode: 'existing',
    targetProjectId,
    keepSourceRelation: false,
    relationType: 'RELATED_TO',
    conflictResolution: 'defer',
    reason: '验收数据有意保留该冲突，用于阻止智能体自动晋级知识。',
    operationActor: 'agent'
  });
}

async function upsertProject(application, personalSpaceId, projectId, name) {
  return application.upsertPersonalProject({
    personalSpaceId,
    projectId,
    profile: {
      name,
      purpose: '可重复使用的 Fuli 实时验收模拟项目。',
      scope: '只验证知识生命周期和选择性项目继承。',
      technicalSummary: '通过公开的个人项目接口创建。',
      lifecycle: 'maintenance',
      sources: [],
      boundaries: ['不得将该验收模拟项目发布为公共项目。']
    }
  });
}

async function captureEntities(application, personalSpaceId, projectId, entities) {
  const result = await application.captureSessionKnowledge({
    targetKind: 'personal',
    spaceId: personalSpaceId,
    personalProjectId: projectId,
    idempotencyKey: `${FIXTURE_VERSION}:${projectId}:entities`,
    sessionId: `knowledge-acceptance-${FIXTURE_VERSION}`,
    name: `${projectId} 验收模拟数据`,
    sourceKind: 'acceptance_test',
    sourceDescription: '通过 Fuli 公开接口创建的可重复实时验收模拟数据。',
    sourceApplication: 'codex',
    referenceTime: REFERENCE_TIME,
    sensitivity: 'private',
    entities,
    relationships: []
  });
  return {
    result,
    ids: Object.fromEntries(
      entities.map(({ key }, index) => [key, result.entity_ids[index]])
    )
  };
}

function entity({
  key,
  name,
  summary,
  status,
  inheritanceMode = 'local_only',
  inheritedProjectIds = [],
  originQuadrant = 'known_known',
  profileAspect = null,
  attributes = {}
}) {
  return {
    key,
    name,
    type: profileAspect ? 'Preference' : 'ProjectKnowledge',
    summary,
    originQuadrant,
    currentQuadrant: originQuadrant,
    epistemicStatus: status === 'confirmed' ? 'confirmed' : 'observed',
    confirmationStatus: status,
    confirmationBasis: confirmationBasis(status, originQuadrant),
    reasoningSummary: originQuadrant === 'known_known'
      ? null
      : '验收规范有意覆盖该知识发现象限。',
    profileAspect,
    inheritanceMode,
    inheritedProjectIds,
    attributes
  };
}

function confirmationBasis(status, originQuadrant) {
  const basis = {
    existenceReason: '用户确认的验收规范要求存在这条模拟知识。',
    quadrantReason: `该验收数据有意从 ${originQuadrant} 象限开始。`,
    proposedBy: { kind: 'agent', label: 'Fuli 中文验收执行器' },
    confirmedBy: null,
    confirmedAt: null
  };
  if (status === 'confirmed') {
    basis.confirmedBy = { kind: 'user', label: '用户确认的验收规范' };
    basis.confirmedAt = REFERENCE_TIME;
  }
  return basis;
}

async function resetPendingEntity(
  application,
  personalSpaceId,
  personalProjectId,
  itemId,
  baseSummary
) {
  const graph = await application.getKnowledgeGraph({
    spaceId: personalSpaceId,
    personalProjectId,
    limit: 500
  });
  const current = graph.nodes.find(({ id }) => id === itemId);
  assert.ok(current, `验收模拟实体 ${itemId} 应当存在`);
  const nextCycle = String(current.summary).endsWith('重置轮次甲。')
    ? '重置轮次乙。'
    : '重置轮次甲。';
  await application.reviseKnowledgeItem({
    personalSpaceId,
    personalProjectId,
    itemKind: 'entity',
    itemId,
    action: 'update',
    reason: '将可重复验收数据重置为新的待确认内容代次。',
    summary: `${baseSummary} ${nextCycle}`,
    confirmationStatus: 'pending',
    confirmationBasis: confirmationBasis('pending', current.origin_quadrant),
    operationActor: 'agent'
  });
}

async function ensureConfirmedClassification(
  application,
  personalSpaceId,
  personalProjectId,
  itemId,
  originQuadrant
) {
  await application.reviseKnowledgeItem({
    personalSpaceId,
    personalProjectId,
    itemKind: 'entity',
    itemId,
    action: 'update',
    reason: '在验收前恢复可重复使用的象限模拟数据。',
    currentQuadrant: originQuadrant,
    confirmationStatus: 'confirmed',
    confirmationBasis: confirmationBasis('confirmed', originQuadrant),
    operationActor: 'agent'
  });
}

function search(application, personalSpaceId, {
  projectId,
  query,
  includePending
}) {
  return application.searchKnowledge({
    personalSpaceId,
    personalProjectId: projectId,
    query,
    includePending,
    limit: 50
  });
}

function recordUse(application, personalSpaceId, itemId, taskId, useKind) {
  return application.recordKnowledgeUsage({
    personalSpaceId,
    taskId,
    sessionId: 'knowledge-acceptance-session',
    toolName: 'knowledge-live-acceptance',
    items: [{
      itemId,
      itemKind: 'entity',
      useKind
    }]
  });
}

async function recordFiveUses(
  application,
  personalSpaceId,
  itemId,
  taskPrefix
) {
  const events = [
    [`${taskPrefix}-1`, 'cited'],
    [`${taskPrefix}-1`, 'applied'],
    [`${taskPrefix}-2`, 'cited'],
    [`${taskPrefix}-2`, 'applied'],
    [`${taskPrefix}-3`, 'cited']
  ];
  let result;
  for (const [taskId, useKind] of events) {
    result = await recordUse(
      application,
      personalSpaceId,
      itemId,
      taskId,
      useKind
    );
  }
  return result.items[0];
}

async function graphNode(
  application,
  personalSpaceId,
  personalProjectId,
  itemId
) {
  const graph = await application.getKnowledgeGraph({
    spaceId: personalSpaceId,
    personalProjectId,
    limit: 500
  });
  const node = graph.nodes.find(({ id }) => id === itemId);
  assert.ok(node, `fixture entity ${itemId} should be in the project graph`);
  return node;
}
