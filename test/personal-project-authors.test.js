import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { callAgentTool } from '../src/agent-tools.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { projectBrief } from '../src/graphiti/project-brief.js';

// HTTP Provider double and synthetic identifiers only.
const SPACE = 'test-space';
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };
const AGENT = { kind: 'agent', agentId: 'agent-ada', agentName: 'Ada' };
const PERSON = { kind: 'person' };
const AT = '2026-11-01T00:00:00.000Z';

// A Provider holding one project (or none) that answers PUT with what it stored.
function provider(stored) {
  const writes = [];
  const fetchImpl = async (url, options = {}) => {
    if ((options.method ?? 'GET') === 'GET') {
      return stored ? Response.json({ project_id: 'p', personal_space_id: SPACE, profile: stored })
        : Response.json({ detail: 'personal project not found' }, { status: 404 });
    }
    const body = JSON.parse(options.body);
    writes.push(body);
    return Response.json({ project_id: 'p', personal_space_id: SPACE, profile: body.profile });
  };
  return { app: new FederatedGraphApplication(config, { fetchImpl }), writes };
}

const save = (app, writer, profile, extra = {}) =>
  app.upsertPersonalProject({ personalSpaceId: SPACE, projectId: 'p', writer, profile: { name: 'P', ...profile }, ...extra });

test('create-only reaches the Provider only when asked and never reads first', async () => {
  const { app, writes } = provider(null);
  await save(app, PERSON, {}, { createOnly: true });
  await save(app, PERSON, {});
  assert.equal(writes[0].create_only, true);
  assert.equal(Object.hasOwn(writes[1], 'create_only'), false);
});

test('an Agent fills empty fields and rewrites its own, recorded with its FLA', async () => {
  const { app } = provider({ name: 'P', scope: 'Old agent scope', authors: { scope: { kind: 'agent', agent_id: 'agent-bo', updated_at: AT } } });
  const saved = await save(app, AGENT, { purpose: 'Track requests', scope: 'New agent scope', boundaries: ['Local only'] });
  assert.equal(saved.profile.purpose, 'Track requests');
  assert.equal(saved.profile.scope, 'New agent scope');
  for (const field of ['purpose', 'scope', 'boundaries']) {
    assert.equal(saved.profile.authors[field].kind, 'agent');
    assert.equal(saved.profile.authors[field].agent_id, 'agent-ada');
    assert.equal(saved.profile.authors[field].agent_name, 'Ada');
  }
  assert.equal(saved.refused_fields, undefined);
});

test('an Agent cannot overwrite or clear what a person wrote; its other fields still apply', async () => {
  const { app } = provider({ name: 'P', purpose: 'Person purpose', scope: 'Shared scope', technical_summary: 'Old agent text',
    authors: { purpose: { kind: 'person', updated_at: AT }, scope: { kind: 'both', agent_id: 'agent-bo', updated_at: AT },
      technical_summary: { kind: 'agent', updated_at: AT } } });
  const saved = await save(app, AGENT, { purpose: 'Agent rewrite', scope: null, technicalSummary: 'New agent text' });
  assert.equal(saved.profile.purpose, 'Person purpose');
  assert.equal(saved.profile.scope, 'Shared scope');
  assert.equal(saved.profile.technical_summary, 'New agent text');
  assert.deepEqual(saved.profile.authors.purpose, { kind: 'person', updated_at: AT });
  assert.deepEqual(saved.refused_fields.map(({ field, author }) => [field, author]), [['purpose', 'person'], ['scope', 'both']]);
  assert.match(saved.refused_fields[0].reason, /人写过的字段，请在控制台修改或请用户确认/);
});

test('a person who keeps much of the Agent text co-authors it; one who replaces it owns it', async () => {
  const agentText = 'Track sample requests for the support team and route them to owners';
  const { app } = provider({ name: 'P', purpose: agentText, scope: 'Draft wording from the agent', technical_summary: 'Untouched',
    boundaries: ['Agent boundary'],
    authors: { purpose: { kind: 'agent', agent_id: 'agent-ada', agent_name: 'Ada', updated_at: AT },
      scope: { kind: 'agent', agent_id: 'agent-ada', updated_at: AT },
      technical_summary: { kind: 'agent', agent_id: 'agent-ada', updated_at: AT },
      boundaries: { kind: 'agent', updated_at: AT } } });
  const saved = await save(app, PERSON, {
    purpose: `${agentText}, weekly.`,
    scope: 'Mine: only local projects',
    technicalSummary: 'Untouched',
    boundaries: []
  });
  assert.deepEqual({ ...saved.profile.authors.purpose, updated_at: undefined },
    { kind: 'both', agent_id: 'agent-ada', agent_name: 'Ada', updated_at: undefined });
  assert.equal(saved.profile.authors.scope.kind, 'person');
  assert.deepEqual(saved.profile.authors.technical_summary, { kind: 'agent', agent_id: 'agent-ada', updated_at: AT });
  assert.equal(Object.hasOwn(saved.profile.authors, 'boundaries'), false);
});

test('the co-author rule keeps Chinese text by characters, at 40% of the previous text', async () => {
  const draft = '记录团队的样例需求并分派给负责人';
  const { app } = provider({ name: 'P', purpose: draft, scope: draft,
    authors: { purpose: { kind: 'agent', updated_at: AT }, scope: { kind: 'agent', updated_at: AT } } });
  const saved = await save(app, PERSON, { purpose: '记录团队的样例需求，每周整理', scope: '只做本机的项目档案' });
  assert.equal(saved.profile.authors.purpose.kind, 'both');
  assert.equal(saved.profile.authors.scope.kind, 'person');
});

test('a person editing person text stays the person; unchanged text keeps its record', async () => {
  const { app } = provider({ name: 'P', purpose: 'Mine', scope: 'Shared',
    authors: { purpose: { kind: 'person', updated_at: AT }, scope: { kind: 'both', agent_name: 'Ada', updated_at: AT } } });
  const saved = await save(app, PERSON, { purpose: 'Mine, edited', scope: 'Shared' });
  assert.equal(saved.profile.authors.purpose.kind, 'person');
  assert.notEqual(saved.profile.authors.purpose.updated_at, AT);
  assert.deepEqual(saved.profile.authors.scope, { kind: 'both', agent_name: 'Ada', updated_at: AT });
});

test('the console route always writes as the person; a body cannot claim another author', async () => {
  const { app, writes } = provider({ name: 'P', purpose: 'Agent text', authors: { purpose: { kind: 'agent', updated_at: AT } } });
  const body = JSON.stringify({ personalSpaceId: SPACE, projectId: 'p', writer: AGENT,
    profile: { name: 'P', purpose: 'Typed by me', authors: { purpose: { kind: 'agent' } } } });
  const request = { method: 'PUT', headers: {}, async *[Symbol.asyncIterator]() { yield Buffer.from(body); } };
  const response = { statusCode: 0, setHeader() {}, writeHead(status) { this.statusCode = status; }, end(text) { this.body = text; } };
  assert.equal(await handleGraphApiRequest({ request, response, url: new URL('http://127.0.0.1/api/personal-projects'), app }), true);
  assert.equal(writes[0].profile.authors.purpose.kind, 'person');
});

test('the Agent tool writes as the FLA of its task', async () => {
  const { app, writes } = provider(null);
  app.taskContextRegistry = { context: async (token) => {
    assert.equal(token, 'fuli-task-synthetic');
    return { personalProjectId: 'p', projectAgentId: 'agent-ada' };
  } };
  app.personal.getProjectAgent = async () => ({ profile: { display_name: 'Ada' } });
  app.getCapturePolicy = () => ({ enabled: true, clients: {} });
  await callAgentTool(app, 'upsert_personal_project', { personalSpaceId: SPACE, projectId: 'p',
    taskContextToken: 'fuli-task-synthetic', sourceApplication: 'opencode', profile: { name: 'P', purpose: 'Agent draft' } });
  assert.deepEqual({ ...writes[0].profile.authors.purpose, updated_at: undefined },
    { kind: 'agent', agent_id: 'agent-ada', agent_name: 'Ada', updated_at: undefined });
});

test('the Agent-facing brief tags each field with its author and weight, AI-only text as a draft', () => {
  const brief = projectBrief({ name: 'P', purpose: 'Person purpose', scope: 'Shared', boundaries: ['Agent boundary'], technical_summary: 'T',
    authors: { purpose: { kind: 'person' }, scope: { kind: 'both' }, boundaries: { kind: 'agent' }, technical_summary: { kind: 'agent' } } });
  assert.deepEqual(brief.authors, { purpose: 'person 100%', scope: 'both 90%', boundaries: 'agent 50% AI 草稿，可改' });
  assert.equal(Object.hasOwn(projectBrief({ name: 'Empty' }), 'authors'), false);
});
