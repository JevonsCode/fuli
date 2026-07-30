import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { FULI_VERSION } from '../src/package-metadata.js';
import { connectMcp } from '../test-support/mcp-client.js';

test('标准输入输出 MCP 应暴露有界图谱工具并静默路由个人知识', async (t) => {
  const received = [];
  const personal = await provider((request) => {
    if (request.path === '/health') return { status: 'ready', providerId: 'personal' };
    if (request.path === '/v1/subscriptions') return [];
    if (request.path === '/v1/spaces') return [{ id: 'personal-1', kind: 'personal' }];
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
  assert.match(instructions, /get_collaboration_preferences/);
  assert.match(instructions, /resolve_deferred_preference_conflict/);
  assert.match(instructions, /each user task/i);
  assert.match(instructions, /before other tools\/answer/i);
  assert.match(instructions, /projectPath=cwd/i);
  assert.match(instructions, /effective_preferences/);
  assert.match(instructions, /personal-global everywhere/i);
  assert.match(instructions, /only Fuli's matched project/i);
  assert.match(instructions, /before (?:saying|answering|claiming).*(?:do not know|don't know|unknown)/i);
  assert.match(instructions, /URLs?.*routes?.*requirements?.*prior decisions?.*runbooks?/i);
  assert.match(instructions, /list_knowledge_spaces/);
  assert.match(instructions, /silently batch/i);
  assert.match(instructions, /personal-global(?: profile)?/i);
  assert.match(instructions, /(?:explicitly )?relevant subscribed public project IDs/i);
  assert.match(instructions, /writes?.*actual payload/i);
  assert.match(instructions, /final text.*not compliance/i);
  assert.match(instructions, /monitoring or Git MCP/i);
  assert.match(instructions, /sourceMarker\.leadMarkdown/);
  assert.match(instructions, /MUST begin/);
  assert.match(instructions, /sourceMarker\.markdown/);
  assert.match(instructions, /noMatchSourceMarker/);
  assert.match(instructions, /terminal-safe Markdown/i);
  assert.match(instructions, /never wrap.*HTML/i);
  assert.match(instructions, /ask.*widen.*all registered local personal projects/i);
  assert.match(instructions, /all_local_confirmed/);
  assert.match(instructions, /never expands public projects/i);
  assert.match(instructions, /current repository or workspace files/i);
  assert.match(instructions, /Grep|rg/);
  assert.match(instructions, /user home.*filesystem root/i);
  assert.match(instructions, /outside.*workspace/i);

  const listed = await connection.client.listTools();
  assert.deepEqual(listed.tools.map(({ name }) => name), [
    'get_collaboration_preferences',
    'resolve_deferred_preference_conflict',
    'capture_session_knowledge', 'search_knowledge_graph', 'record_knowledge_usage',
    'get_knowledge_graph',
    'search_human_knowledge_changes', 'review_human_knowledge_change',
    'list_knowledge_spaces', 'upsert_personal_project', 'list_personal_projects',
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
  assert.match(applyProjectTool.description, /never call.*read-only task/i);
  assert.match(applyProjectTool.description, /previewToken/i);

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
  assert.equal(received.length, 1);
  assert.equal(received[0].episode.entities[0].type, 'DevelopmentRule');

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
  assert.equal(received.length, 1);

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
    const payload = handler({
      path: new URL(request.url, 'http://localhost').pathname,
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
