import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FULI_VERSION } from '../src/package-metadata.js';
import { connectMcp } from '../test-support/mcp-client.js';

test('标准输入输出 MCP 应暴露有界图谱工具并静默路由个人知识', async (t) => {
  const received = [];
  const searchRequests = [];
  const personal = await provider((request) => {
    if (request.path === '/health') return { status: 'ready', providerId: 'personal' };
    if (request.path === '/v1/subscriptions') return [];
    if (request.path === '/v1/spaces') return [{ id: 'personal-1', kind: 'personal' }];
    if (request.path === '/v1/personal-projects') {
      return [{ project_id: 'hotel-b', personal_space_id: 'personal-1' }];
    }
    if (request.path === '/v1/collaboration-preferences') {
      const preference = {
        id: 'preference-1',
        item_kind: 'entity',
        key: 'writing.direct',
        preference_key: 'writing.direct',
        title: 'Direct writing',
        instruction: 'Use direct, low-fluff writing.',
        profile_aspect: 'taste',
        preference_scope: 'global',
        preference_project_id: null,
        attributes: {
          preferenceKey: 'writing.direct',
          auditContext: 'confirmed collaboration preference '.repeat(12)
        },
        confirmed_at: '2026-07-28T08:53:17.735000Z',
        created_at: '2026-07-28T08:50:06.705831Z'
      };
      return {
        personal_space_id: 'personal-1',
        personal_project_id: request.query?.personal_project_id ?? null,
        global_preferences: [preference],
        project_preferences: [],
        effective_preferences: [preference],
        conflicts: [],
        overridden_global_ids: [],
        truncated: false
      };
    }
    if (request.path === '/v1/search') {
      searchRequests.push(request.body);
      if (request.body.query === 'missing page URL') return { facts: [], entities: [] };
      return {
        facts: [],
        entities: [{
          id: 'entity-1',
          space_id: 'personal-1',
          name: 'Fuli 来源标记',
          type: 'ProductRequirement',
          summary: '使用 Fuli 的回答必须提供可展开来源。',
          confirmation_status: 'pending',
          confidence_score: 0.35,
          utility_score: 0
        }]
      };
    }
    if (request.path === '/v1/knowledge/commits') {
      received.push(request.body);
      return {
        status: 'committed', space_id: 'personal-1', episode_id: 'episode-1',
        entity_ids: ['entity-1'], relationship_ids: []
      };
    }
    return [];
  });
  const workspace = await provider((request) => {
    if (request.path === '/health') return { status: 'ready', providerId: 'workspace' };
    if (request.path === '/v1/spaces') return [{ id: 'project-1', kind: 'project' }];
    return [];
  });
  t.after(() => Promise.all([close(personal.server), close(workspace.server)]));

  const runtimeConfigPath = join(mkdtempSync(join(tmpdir(), 'fuli-mcp-graph-')), 'runtime.json');
  const hotelProjectPath = join(dirname(runtimeConfigPath), 'hotel-b');
  mkdirSync(hotelProjectPath);
  writeFileSync(runtimeConfigPath, JSON.stringify({
    version: 1,
    personal: {
      providerUrl: personal.url,
      accessToken: 'personal-access',
      principalId: 'principal-personal',
      spaceId: 'personal-1'
    },
    workspaces: [{
      providerUrl: workspace.url,
      accessToken: 'workspace-access',
      principalId: 'principal-workspace'
    }]
  }));

  const connection = await connectMcp(runtimeConfigPath);
  t.after(() => connection.close());
  assert.deepEqual(connection.client.getServerVersion(), {
    name: 'fuli',
    version: FULI_VERSION
  });
  const instructions = connection.client.getInstructions();
  assert.ok(
    Buffer.byteLength(instructions, 'utf8') <= 2048,
    'Claude Code 会裁剪超过 2 KiB 的 MCP 服务说明'
  );
  assert.match(instructions, /search_knowledge_graph/);
  assert.match(instructions, /search_current_project_knowledge/);
  assert.match(instructions, /begin_task_context/);
  assert.match(instructions, /hook-provided task context/i);
  assert.match(instructions, /checkpoint_task_knowledge/);
  assert.match(instructions, /capture_candidates.*retain_nothing/i);
  assert.match(instructions, /record_decision_trace/);
  assert.match(instructions, /record_knowledge_feedback/);
  assert.match(instructions, /get_collaboration_preferences/);
  assert.match(instructions, /deferred_conflict/);
  assert.match(instructions, /each user task/i);
  assert.match(instructions, /before other tools\/answer/i);
  assert.match(instructions, /projectPath=cwd/i);
  assert.match(instructions, /effective_preferences/);
  assert.match(instructions, /personal-global everywhere/i);
  assert.match(instructions, /only Fuli's matched project/i);
  assert.match(instructions, /before (?:saying|answering|claiming).*(?:do not know|don't know|unknown)/i);
  assert.match(instructions, /active child first.*inheritable parent/i);
  assert.match(instructions, /exact IDs for extra projects/i);
  assert.match(instructions, /Batch durable confirmed knowledge/i);
  assert.match(instructions, /writes?.*actual payload/i);
  assert.match(instructions, /final text.*not compliance/i);
  assert.match(instructions, /monitoring\/Git MCP/i);
  assert.match(instructions, /sourceMarker\.leadMarkdown/);
  assert.match(instructions, /MUST begin/);
  assert.match(instructions, /sourceMarker\.markdown/);
  assert.match(instructions, /noMatchSourceMarker/);
  assert.match(instructions, /terminal-safe Markdown/i);
  assert.match(instructions, /never wrap.*HTML/i);
  assert.match(instructions, /all_local_confirmed/);
  assert.match(instructions, /only after consent/i);
  assert.match(instructions, /safe current repo\/workspace/i);
  assert.match(instructions, /Never scan outside it/i);

  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), [
    'begin_task_context',
    'checkpoint_task_knowledge',
    'verify_task_checkpoint',
    'get_collaboration_preferences',
    'resolve_deferred_preference_conflict',
    'capture_session_knowledge', 'record_decision_trace',
    'search_knowledge_graph', 'search_connected_knowledge',
    'record_knowledge_usage', 'record_knowledge_feedback',
    'search_current_project_knowledge',
    'discover_common_knowledge_candidates',
    'preview_common_knowledge_promotion', 'apply_common_knowledge_promotion',
    'get_knowledge_graph',
    'search_human_knowledge_changes', 'review_human_knowledge_change',
    'list_knowledge_spaces', 'upsert_personal_project', 'list_personal_projects',
    'start_knowledge_review', 'list_knowledge_review_candidates',
    'record_knowledge_review_progress', 'finish_knowledge_review',
    'revise_personal_knowledge', 'reassign_personal_knowledge',
    'set_personal_preference_scope',
    'preview_personal_project_action', 'apply_personal_project_action',
    'publish_personal_project', 'list_project_releases',
    'create_project_relation', 'list_project_relations',
    'review_project_relation', 'list_personal_review_queue', 'review_personal_draft',
    'subscribe_public_project', 'unsubscribe_public_project',
    'list_project_review_queue', 'review_project_proposal',
    'get_graphiti_status'
  ]);
  const preferencesTool = listed.tools.find(
    ({ name }) => name === 'get_collaboration_preferences'
  );
  const previewProjectTool = listed.tools.find(
    ({ name }) => name === 'preview_personal_project_action'
  );
  const applyProjectTool = listed.tools.find(
    ({ name }) => name === 'apply_personal_project_action'
  );
  assert.equal(preferencesTool.title, 'READ FIRST · Load task collaboration preferences');
  assert.equal(previewProjectTool.title, 'PREVIEW · Authorize a personal project write');
  assert.equal(applyProjectTool.title, 'WRITE · Apply an authorized personal project action');
  assert.match(preferencesTool.description, /exact tool name/i);
  assert.match(preferencesTool.description, /taskPrompt/);
  assert.match(preferencesTool.description, /task_knowledge_recall/);
  assert.match(preferencesTool.description, /focused action, artifact, target-system/i);
  assert.match(applyProjectTool.description, /never call.*read-only task/i);
  assert.match(applyProjectTool.description, /previewToken/i);

  const taskContext = await connection.client.callTool({
    name: 'begin_task_context',
    arguments: {
      sessionId: 'mcp-lifecycle-session',
      projectPath: dirname(runtimeConfigPath)
    }
  });
  assert.equal(taskContext.isError, undefined);
  assert.match(
    taskContext.structuredContent.task_context_token,
    /^fuli-task-/
  );
  assert.equal(
    taskContext.structuredContent.taskContextToken,
    taskContext.structuredContent.task_context_token
  );
  const taskHookOutput = JSON.parse(taskContext.content[0].text);
  assert.equal(
    taskHookOutput.hookSpecificOutput.hookEventName,
    'UserPromptSubmit'
  );
  assert.match(
    taskHookOutput.hookSpecificOutput.additionalContext,
    /taskContextToken/
  );
  assert.equal(
    taskContext.structuredContent.effective_preferences[0].instruction,
    'Use direct, low-fluff writing.'
  );

  const pendingCheckpoint = await connection.client.callTool({
    name: 'verify_task_checkpoint',
    arguments: { sessionId: 'mcp-lifecycle-session' }
  });
  assert.equal(pendingCheckpoint.structuredContent.decision, 'block');
  assert.match(
    pendingCheckpoint.structuredContent.reason,
    /checkpoint_task_knowledge/
  );

  const checkpoint = await connection.client.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: taskContext.structuredContent.task_context_token,
      disposition: 'retain_nothing',
      reason: 'This synthetic task produced no durable knowledge.'
    }
  });
  assert.equal(checkpoint.structuredContent.status, 'checkpointed');
  assert.equal(checkpoint.structuredContent.disposition, 'retain_nothing');

  const completedCheckpoint = await connection.client.callTool({
    name: 'verify_task_checkpoint',
    arguments: { sessionId: 'mcp-lifecycle-session' }
  });
  assert.equal(completedCheckpoint.structuredContent.decision, undefined);
  assert.equal(completedCheckpoint.structuredContent.status, 'checkpointed');

  const projectTask = await connection.client.callTool({
    name: 'begin_task_context',
    arguments: {
      sessionId: 'mcp-project-session',
      projectPath: hotelProjectPath
    }
  });
  assert.equal(projectTask.isError, undefined, JSON.stringify(projectTask));
  assert.equal(
    projectTask.structuredContent.context.personal_project_id,
    'hotel-b'
  );
  const capturedCheckpoint = await connection.client.callTool({
    name: 'checkpoint_task_knowledge',
    arguments: {
      taskContextToken: projectTask.structuredContent.task_context_token,
      disposition: 'capture_candidates',
      reason: 'The synthetic task produced one bounded pending candidate.',
      capture: {
        idempotencyKey: 'mcp-project-session-candidate-v1',
        name: 'Synthetic task candidate',
        sourceKind: 'synthetic_test',
        sourceDescription: 'Synthetic MCP lifecycle acceptance evidence.',
        sourceApplication: 'other',
        referenceTime: '2026-07-31T00:00:00.000Z',
        summary: 'Synthetic candidate only; not a production fact.',
        sensitivity: 'private',
        entities: [{
          key: 'synthetic.lifecycle.candidate',
          name: 'Synthetic lifecycle candidate',
          type: 'TestKnowledge',
          summary: 'Synthetic candidate only.',
          originQuadrant: 'known_known',
          confirmationStatus: 'pending',
          confirmationBasis: {
            existenceReason: 'Generated by a synthetic lifecycle test.',
            quadrantReason: 'The fixture states the candidate directly.',
            proposedBy: { kind: 'agent', label: 'MCP lifecycle test' }
          },
          inheritanceMode: 'local_only',
          inheritedProjectIds: [],
          attributes: {}
        }],
        relationships: []
      }
    }
  });
  assert.equal(capturedCheckpoint.structuredContent.status, 'checkpointed');
  assert.equal(capturedCheckpoint.structuredContent.capture.status, 'committed');
  assert.equal(received.at(-1).personal_project_id, 'hotel-b');
  assert.equal(received.at(-1).episode.session_id, 'mcp-project-session');

  const projectSearch = await connection.client.callTool({
    name: 'search_current_project_knowledge',
    arguments: {
      projectPath: hotelProjectPath,
      queries: ['how to run locally', 'how to validate'],
      includeHistorical: false,
      includePending: false,
      limitPerQuery: 8
    }
  });
  assert.equal(projectSearch.isError, undefined);
  assert.equal(projectSearch.structuredContent.personal_project_id, 'hotel-b');
  assert.equal(projectSearch.structuredContent.results.length, 2);
  assert.deepEqual(
    searchRequests.slice(-2).map((request) => ({
      projects: request.personal_project_ids,
      active: request.active_personal_project_id,
      inherit: request.inherit_project_knowledge
    })),
    [
      { projects: ['hotel-b'], active: 'hotel-b', inherit: true },
      { projects: ['hotel-b'], active: 'hotel-b', inherit: true }
    ]
  );

  const preferences = await connection.client.callTool({
    name: 'get_collaboration_preferences',
    arguments: { projectPath: dirname(runtimeConfigPath) }
  });
  assert.equal(preferences.isError, undefined);
  assert.equal(
    preferences.structuredContent.effective_preferences[0].instruction,
    'Use direct, low-fluff writing.'
  );
  assert.equal(
    preferences.structuredContent.effective_preferences[0].preference_key,
    'writing.direct'
  );
  assert.equal('global_preferences' in preferences.structuredContent, false);
  assert.equal(
    preferences.structuredContent.application_guidance.apply,
    'effective_preferences'
  );

  const captured = await connection.client.callTool({
    name: 'capture_session_knowledge',
    arguments: personalCapture()
  });
  assert.equal(captured.isError, undefined);
  assert.equal(captured.structuredContent.route, 'personal');
  assert.equal(received.length, 2);
  assert.equal(received.at(-1).episode.entities[0].type, 'DevelopmentRule');
  assert.equal(
    received.at(-1).episode.source_uri,
    'https://docs.example.invalid/project/shared-module-rule'
  );

  const searched = await connection.client.callTool({
    name: 'search_knowledge_graph',
    arguments: {
      personalSpaceId: 'personal-1',
      query: 'Fuli 来源标记'
    }
  });
  assert.equal(searched.structuredContent.sourceMarker.status, 'matched');
  assert.equal(searched.structuredContent.noMatchSourceMarker.status, 'no_match');
  assert.equal(
    searched.structuredContent.retrievalGuidance.requiredNextActionIfNoSupportingEvidence,
    'ask_user_to_confirm_all_local_and_workspace_search'
  );
  assert.deepEqual(
    searched.structuredContent.retrievalGuidance.expansion.input,
    { personalProjectScope: 'all_local_confirmed' }
  );
  assert.match(
    searched.structuredContent.sourceMarker.leadMarkdown,
    /^\*\*\[🌠 FULI · 知识增强\]/
  );
  assert.match(
    searched.structuredContent.sourceMarker.markdown,
    /^\*\*FULI 来源 · 1 条\*\*/
  );
  assert.doesNotMatch(
    searched.structuredContent.sourceMarker.markdown,
    /<\/?(?:details|summary)>/i
  );
  assert.doesNotMatch(
    searched.structuredContent.noMatchSourceMarker.markdown,
    /<\/?(?:details|summary)>/i
  );
  assert.equal(searched.structuredContent.noMatchSourceMarker.markdown, '');
  assert.match(
    searched.structuredContent.sourceMarker.markdown,
    /#\/knowledge\/personal\/personal-1\/entity\/entity-1/
  );
  assert.doesNotMatch(searched.structuredContent.sourceMarker.markdown, /truncated/);
  assert.equal(
    searched.structuredContent.entities[0].summary,
    '使用 Fuli 的回答必须提供可展开来源。'
  );
  assert.equal(searched.structuredContent.entities[0].confirmation_status, 'pending');
  assert.equal(searched.structuredContent.entities[0].confidence_score, 0.35);
  assert.ok(
    Buffer.byteLength(searched.content[0].text, 'utf8') <= 32 * 1024,
    '知识检索在保留模型可见证据的同时必须保持有界'
  );

  const missed = await connection.client.callTool({
    name: 'search_knowledge_graph',
    arguments: {
      personalSpaceId: 'personal-1',
      query: 'missing page URL'
    }
  });
  assert.equal(missed.structuredContent.sourceMarker.status, 'no_match');
  assert.equal(missed.structuredContent.noMatchSourceMarker.status, 'no_match');
  assert.equal(missed.structuredContent.noMatchSourceMarker.markdown, '');
  assert.doesNotMatch(
    missed.structuredContent.noMatchSourceMarker.markdown,
    /<\/?(?:details|summary)>/i
  );
  assert.equal(
    JSON.parse(missed.content[0].text)
      .retrievalGuidance.requiredNextActionIfNoSupportingEvidence,
    'ask_user_to_confirm_all_local_and_workspace_search'
  );

  const missedAllLocal = await connection.client.callTool({
    name: 'search_knowledge_graph',
    arguments: {
      personalSpaceId: 'personal-1',
      personalProjectScope: 'all_local_confirmed',
      query: 'missing page URL'
    }
  });
  const modelVisibleMiss = JSON.parse(missedAllLocal.content[0].text);
  assert.equal(
    modelVisibleMiss.retrievalGuidance.requiredNextActionIfNoSupportingEvidence,
    'search_current_workspace_files_or_ask_for_safe_root'
  );
  assert.deepEqual(
    modelVisibleMiss.retrievalGuidance.workspaceFileSearch.forbiddenBroadRoots,
    ['user_home', 'filesystem_root']
  );
  assert.equal(
    modelVisibleMiss.retrievalGuidance.workspaceFileSearch.rootBoundary,
    'current_working_directory'
  );

  const secret = 'sk-live-12345678901234567890';
  const rejected = await connection.client.callTool({
    name: 'capture_session_knowledge',
    arguments: { ...personalCapture(), summary: `api_key=${secret}` }
  });
  assert.equal(rejected.isError, true);
  assert.equal(JSON.stringify(rejected).includes(secret), false);
  assert.equal(received.length, 2);

  await assert.rejects(connection.client.listResources(), /Method not found/);
  await assert.rejects(connection.client.listPrompts(), /Method not found/);
});

test('Agent 项目写入必须使用匹配且一次性的预览授权', async (t) => {
  let writes = 0;
  const personal = await provider((request) => {
    if (request.path === '/health') return { status: 'ready', providerId: 'personal' };
    if (request.path === '/v1/subscriptions') return [];
    if (request.path === '/v1/spaces') return [{ id: 'personal-1', kind: 'personal' }];
    if (request.path === '/v1/knowledge/items/entity-1/project-action/preview') {
      return {
        item_id: 'entity-1',
        item_name: '部署规则',
        item_summary: '复用父项目部署规则。',
        source_project_id: 'project-parent',
        target_project_id: request.body.target_project_id,
        match: { kind: 'none', reason: '目标项目尚未引用这条知识。' },
        default_resolution: 'defer'
      };
    }
    if (request.path === '/v1/knowledge/items/entity-1/project-action') {
      writes += 1;
      return {
        status: 'linked',
        source_project_id: 'project-parent',
        target_project_id: request.body.target_project_id,
        project_created: false,
        project_relation_created: false,
        match: { kind: 'none', reason: '目标项目尚未引用这条知识。' }
      };
    }
    return [];
  });
  t.after(() => close(personal.server));

  const runtimeConfigPath = join(
    mkdtempSync(join(tmpdir(), 'fuli-mcp-project-action-')),
    'runtime.json'
  );
  writeFileSync(runtimeConfigPath, JSON.stringify({
    version: 1,
    personal: {
      providerUrl: personal.url,
      accessToken: 'personal-access',
      principalId: 'principal-personal',
      spaceId: 'personal-1'
    },
    workspaces: []
  }));
  const connection = await connectMcp(runtimeConfigPath);
  t.after(() => connection.close());

  const action = {
    personalSpaceId: 'personal-1',
    itemKind: 'entity',
    itemId: 'entity-1',
    mode: 'existing',
    targetProjectId: 'project-a',
    newProjectId: null,
    newProjectName: null,
    newProjectPurpose: null,
    keepSourceRelation: true,
    relationType: 'RELATED_TO',
    conflictResolution: 'defer',
    reason: '让项目 A 复用这条部署规则'
  };

  const withoutPreview = await connection.client.callTool({
    name: 'apply_personal_project_action',
    arguments: action
  });
  assert.equal(withoutPreview.isError, true);
  assert.equal(withoutPreview.structuredContent.error.code, 'validation');
  assert.equal(writes, 0);

  const preview = await connection.client.callTool({
    name: 'preview_personal_project_action',
    arguments: action
  });
  assert.equal(preview.isError, undefined);
  assert.match(preview.structuredContent.previewToken, /^[A-Za-z0-9_-]{20,}$/);

  const changedTarget = await connection.client.callTool({
    name: 'apply_personal_project_action',
    arguments: {
      ...action,
      targetProjectId: 'project-b',
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(changedTarget.isError, true);
  assert.equal(changedTarget.structuredContent.error.code, 'preview_mismatch');
  assert.equal(writes, 0);

  const applied = await connection.client.callTool({
    name: 'apply_personal_project_action',
    arguments: {
      ...action,
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(applied.isError, undefined);
  assert.equal(writes, 1);

  const replayed = await connection.client.callTool({
    name: 'apply_personal_project_action',
    arguments: {
      ...action,
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(replayed.isError, true);
  assert.equal(replayed.structuredContent.error.code, 'preview_expired');
  assert.equal(writes, 1);
});

test('公共知识上收必须使用匹配且一次性的人工确认预览', async (t) => {
  let writes = 0;
  const personal = await provider((request) => {
    if (request.path === '/health') return { status: 'ready', providerId: 'personal' };
    if (request.path === '/v1/subscriptions') return [];
    if (request.path === '/v1/spaces') return [{ id: 'personal-1', kind: 'personal' }];
    if (request.path === '/v1/knowledge/common-promotions/preview') {
      return {
        status: 'ready',
        personal_space_id: 'personal-1',
        parent_project_id: 'platform-a',
        item_kind: 'entity',
        canonical_item_id: 'canonical',
        duplicate_item_ids: ['duplicate'],
        source_project_ids: ['flight-c', 'hotel-b'],
        inheritance_mode: 'descendants',
        atomic: true,
        requires_human_confirmation: true,
        reason: request.body.reason,
        human_confirmation_reason: request.body.human_confirmation_reason
      };
    }
    if (request.path === '/v1/knowledge/common-promotions') {
      writes += 1;
      return {
        status: 'promoted',
        promotion_id: 'promotion-1',
        personal_space_id: 'personal-1',
        parent_project_id: 'platform-a',
        item_kind: 'entity',
        canonical_item_id: 'canonical',
        invalidated_item_ids: ['duplicate'],
        source_project_ids: ['flight-c', 'hotel-b'],
        inheritance_mode: 'descendants',
        revision_ids: ['revision-1', 'revision-2'],
        reason: request.body.reason,
        human_confirmation_reason: request.body.human_confirmation_reason
      };
    }
    return [];
  });
  t.after(() => close(personal.server));

  const runtimeConfigPath = join(
    mkdtempSync(join(tmpdir(), 'fuli-mcp-common-promotion-')),
    'runtime.json'
  );
  writeFileSync(runtimeConfigPath, JSON.stringify({
    version: 1,
    personal: {
      providerUrl: personal.url,
      accessToken: 'personal-access',
      principalId: 'principal-personal',
      spaceId: 'personal-1'
    },
    workspaces: []
  }));
  const connection = await connectMcp(runtimeConfigPath);
  t.after(() => connection.close());

  const promotion = {
    personalSpaceId: 'personal-1',
    parentProjectId: 'platform-a',
    itemKind: 'entity',
    canonicalItemId: 'canonical',
    duplicateItemIds: ['duplicate'],
    reason: 'Synthetic shared runbook evidence.',
    humanConfirmationReason: 'The synthetic benchmark explicitly approved this exact intent.'
  };

  const preview = await connection.client.callTool({
    name: 'preview_common_knowledge_promotion',
    arguments: promotion
  });
  assert.equal(preview.isError, undefined);
  assert.equal(preview.structuredContent.atomic, true);
  assert.match(preview.structuredContent.previewToken, /^[A-Za-z0-9_-]{20,}$/);

  const mismatched = await connection.client.callTool({
    name: 'apply_common_knowledge_promotion',
    arguments: {
      ...promotion,
      reason: 'Changed rationale.',
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(mismatched.isError, true);
  assert.equal(mismatched.structuredContent.error.code, 'preview_mismatch');
  assert.equal(writes, 0);

  const applied = await connection.client.callTool({
    name: 'apply_common_knowledge_promotion',
    arguments: {
      ...promotion,
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(applied.isError, undefined);
  assert.equal(applied.structuredContent.status, 'promoted');
  assert.equal(writes, 1);

  const replayed = await connection.client.callTool({
    name: 'apply_common_knowledge_promotion',
    arguments: {
      ...promotion,
      previewToken: preview.structuredContent.previewToken
    }
  });
  assert.equal(replayed.isError, true);
  assert.equal(replayed.structuredContent.error.code, 'preview_expired');
  assert.equal(writes, 1);
});

function personalCapture() {
  return {
    targetKind: 'personal',
    spaceId: 'personal-1',
    providerUrl: null,
    idempotencyKey: 'session-1-batch-1',
    sessionId: 'session-1',
    name: 'Project-scoped personal rule',
    sourceKind: 'conversation',
    sourceDescription: 'Confirmed user instruction',
    sourceUri: 'https://docs.example.invalid/project/shared-module-rule',
    referenceTime: '2026-07-21T10:00:00.000Z',
    summary: 'Ask before changing shared modules',
    sensitivity: 'normal',
    entities: [{
      key: 'rule:shared-modules',
      name: 'Shared module change rule',
      type: 'DevelopmentRule',
      summary: 'Explain reason, change set, and impact first',
      originQuadrant: 'known_known',
      confirmationStatus: 'confirmed',
      confirmationBasis: {
        existenceReason: 'The user explicitly stated this rule.',
        quadrantReason: 'The rule was explicitly expressed.',
        proposedBy: { kind: 'agent', label: 'Codex' },
        confirmedBy: { kind: 'user', label: 'Current user' },
        confirmedAt: '2026-07-21T10:00:00.000Z'
      },
      attributes: {}
    }],
    relationships: []
  };
}

async function provider(handler) {
  const server = createServer(async (request, response) => {
    const body = await readBody(request);
    const url = new URL(request.url, 'http://localhost');
    const payload = handler({
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      method: request.method,
      body
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
}

function close(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
