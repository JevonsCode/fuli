import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import { agentInterfaceCatalog } from '../src/agent-tools/interface-catalog.js';
import { inspectLocalStores } from '../src/data-format/local-stores.js';
import { FederatedGraphApplication, openFederatedGraphApplication } from '../src/graphiti/federated-application.js';
import { PERSON_WRITER, UNNAMED_AGENT_WRITER } from '../src/graphiti/project-profile-authors.js';
import { handleGraphApiRequest } from '../src/http/graph-api-router.js';
import { createProjectChangeLog } from '../src/project-change-log/port.js';

// HTTP Provider double, temp directories and synthetic identifiers only.
const SPACE = 'test-space';
const AT = '2026-11-01T00:00:00.000Z';
const AGENT = { kind: 'agent', agentId: 'agent-ada', agentName: 'Ada' };
const config = { version: 1, workspaces: [],
  personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'synthetic-provider-token', principalId: 'test-person', spaceId: SPACE } };

// Removed after every test closed its store: Windows keeps an open database's file.
const root = mkdtempSync(join(tmpdir(), 'fuli-project-change-log-'));
after(() => rmSync(root, { recursive: true, force: true }));
const directory = () => mkdtempSync(join(root, 'store-'));

function changeLog(t) {
  const log = createProjectChangeLog({ path: join(directory(), 'project-change-log.sqlite'), now: () => new Date(AT) });
  t.after(() => log.close());
  return log;
}

// An application over a Provider that keeps one project and answers PUT with what it stored.
function application(t, stored, { failSave = false } = {}) {
  let profile = stored;
  const fetchImpl = async (url, options = {}) => {
    if ((options.method ?? 'GET') === 'GET') {
      return profile ? Response.json({ project_id: 'p', personal_space_id: SPACE, profile })
        : Response.json({ detail: 'personal project not found' }, { status: 404 });
    }
    if (failSave) return Response.json({ detail: 'personal project already exists' }, { status: 409 });
    profile = JSON.parse(options.body).profile;
    return Response.json({ project_id: 'p', personal_space_id: SPACE, profile });
  };
  const app = new FederatedGraphApplication(config, { fetchImpl });
  app.projectChangeLog = changeLog(t);
  return app;
}

const save = (app, writer, profile, extra = {}) => app.upsertPersonalProject({ personalSpaceId: SPACE, projectId: 'p', writer,
  profile: { name: 'P', lifecycle: 'active', ...profile }, ...extra });
const history = (app, input = {}) => app.listPersonalProjectHistory({ personalSpaceId: SPACE, projectId: 'p', ...input });

test('a save appends one row naming who changed which fields, with their before and after text', async (t) => {
  const app = application(t, { name: 'P', lifecycle: 'active', purpose: 'Old purpose', boundaries: ['Local only'] });
  await save(app, PERSON_WRITER, { name: 'Q', purpose: 'New purpose', boundaries: ['Local only', 'No cloud'],
    sources: [{ key: 'repo', kind: 'repository', title: 'Repo', uri: 'https://example.test/repo' }] });
  const { entries, hasMore } = history(app);
  assert.equal(hasMore, false);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].actor, { kind: 'person', agentId: null, agentName: null });
  assert.deepEqual(entries[0].changes, [
    { field: 'name', before: 'P', after: 'Q' },
    { field: 'purpose', before: 'Old purpose', after: 'New purpose' },
    { field: 'boundaries', before: 'Local only', after: 'Local only\nNo cloud' },
    { field: 'sources', before: '', after: 'Repo · https://example.test/repo' },
  ]);
});

test('a save that changes nothing appends nothing, whatever else the profile carries', async (t) => {
  const stored = { name: 'P', lifecycle: 'active', purpose: 'Same', scope: null, boundaries: [],
    authors: { purpose: { kind: 'person', updated_at: AT } } };
  const app = application(t, stored);
  await save(app, PERSON_WRITER, { purpose: '  Same  ', scope: '', boundaries: ['  '],
    assessment: { score: 40, label: 'draft', analyzed_at: AT } });
  assert.deepEqual(history(app).entries, []);
});

test('what an Agent was refused is not recorded; what it did change is, under its id and name', async (t) => {
  const app = application(t, { name: 'P', lifecycle: 'active', purpose: 'Person purpose', scope: 'Old scope',
    authors: { purpose: { kind: 'person', updated_at: AT } } });
  const saved = await save(app, AGENT, { purpose: 'Agent rewrite', scope: 'New scope' });
  assert.equal(saved.refused_fields.length, 1);
  const [entry] = history(app).entries;
  assert.deepEqual(entry.actor, { kind: 'agent', agentId: 'agent-ada', agentName: 'Ada' });
  assert.deepEqual(entry.changes, [{ field: 'scope', before: 'Old scope', after: 'New scope' }]);
});

test('an Agent refused everything leaves no row', async (t) => {
  const app = application(t, { name: 'P', lifecycle: 'active', purpose: 'Person purpose',
    authors: { purpose: { kind: 'person', updated_at: AT } } });
  await save(app, AGENT, { purpose: 'Agent rewrite' });
  assert.deepEqual(history(app).entries, []);
});

test('a new project is recorded from nothing, and FULI\'s own draft is FULI', async (t) => {
  const app = application(t, null);
  await save(app, UNNAMED_AGENT_WRITER, { purpose: 'Drafted from the README' }, { createOnly: true });
  const [entry] = history(app).entries;
  assert.deepEqual(entry.actor, { kind: 'fuli', agentId: null, agentName: null });
  assert.deepEqual(entry.changes, [{ field: 'name', before: '', after: 'P' },
    { field: 'purpose', before: '', after: 'Drafted from the README' },
    { field: 'lifecycle', before: '', after: 'active' }]);
});

test('a save the Provider refused records nothing', async (t) => {
  const app = application(t, null, { failSave: true });
  await assert.rejects(save(app, PERSON_WRITER, { purpose: 'Taken' }, { createOnly: true }), { status: 409 });
  assert.deepEqual(history(app).entries, []);
});

test('a change log that cannot be written never fails the save', async (t) => {
  const app = application(t, { name: 'P', lifecycle: 'active', purpose: 'Old' });
  const warnings = [];
  // A directory where the store's file should be: every open fails.
  app.projectChangeLog = createProjectChangeLog({ path: directory(), warn: (message) => warnings.push(message) });
  const saved = await save(app, PERSON_WRITER, { purpose: 'New' });
  assert.equal(saved.profile.purpose, 'New');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /project p was saved/);
  assert.doesNotMatch(warnings[0], /New/);
});

test('a read is newest first, bounded by its limit, and says when more exist', (t) => {
  const log = changeLog(t);
  for (const text of ['one', 'two', 'three']) {
    log.record({ personalSpaceId: SPACE, projectId: 'p', writer: PERSON_WRITER, previous: { name: 'P' },
      saved: { profile: { name: 'P', purpose: text } } });
  }
  log.record({ personalSpaceId: SPACE, projectId: 'other', writer: PERSON_WRITER, previous: { name: 'O' },
    saved: { profile: { name: 'O', purpose: 'elsewhere' } } });
  const read = (limit) => log.list({ personalSpaceId: SPACE, projectId: 'p', limit });
  assert.deepEqual(read(2).entries.map(({ changes }) => changes[0].after), ['three', 'two']);
  assert.equal(read(2).hasMore, true);
  assert.equal(read(3).hasMore, false);
  assert.equal(read(null).entries.length, 3);
  for (const limit of [0, -1, 1.5, Number.NaN, 201]) assert.throws(() => read(limit), { code: 'invalid_input' }, String(limit));
});

test('the store is append-only and a read creates no file', (t) => {
  const path = join(directory(), 'project-change-log.sqlite');
  const log = createProjectChangeLog({ path });
  t.after(() => log.close());
  assert.deepEqual(log.list({ personalSpaceId: SPACE, projectId: 'p' }), { entries: [], hasMore: false });
  assert.equal(existsSync(path), false);
  assert.equal(inspectLocalStores(join(path, '..')).find(({ label }) => label === 'project-change-log.sqlite').state, 'absent');
  log.record({ personalSpaceId: SPACE, projectId: 'p', writer: AGENT, previous: null, saved: { profile: { name: 'P' } } });
  assert.equal(inspectLocalStores(join(path, '..')).find(({ label }) => label === 'project-change-log.sqlite').state, 'current');
  const database = new DatabaseSync(path);
  t.after(() => database.close());
  assert.throws(() => database.exec(`UPDATE project_changes SET changes = '[]'`), /immutable/);
  assert.throws(() => database.exec('DELETE FROM project_changes'), /immutable/);
});

test('GET /api/personal-projects/:projectId/history reads one project of the active space', async (t) => {
  const app = application(t, { name: 'P', lifecycle: 'active', purpose: 'Old' });
  await save(app, PERSON_WRITER, { purpose: 'New' });
  async function request(path) {
    let status = null;
    let body = '';
    const response = { writeHead(code) { status = code; }, end(text) { body = text; }, setHeader() {} };
    const url = new URL(path, 'http://127.0.0.1');
    const handled = await handleGraphApiRequest({ request: { method: 'GET', headers: {} }, response, url, app });
    return { handled, status, body: body ? JSON.parse(body) : null };
  }
  const answer = await request(`/api/personal-projects/p/history?personalSpaceId=${SPACE}&limit=5`);
  assert.equal(answer.handled, true);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.entries[0].changes, [{ field: 'purpose', before: 'Old', after: 'New' }]);
  await assert.rejects(request('/api/personal-projects/p/history?personalSpaceId=other-space'), TypeError);
  await assert.rejects(request(`/api/personal-projects/p/history?personalSpaceId=${SPACE}&limit=many`), { code: 'invalid_input' });
});

test('the interface catalog names the read route', () => {
  const projects = agentInterfaceCatalog().readWorkflows.find(({ domain }) => domain === 'projects');
  assert.deepEqual(projects.readRoutes, ['GET /api/personal-projects/:projectId/history']);
});

test('a locally opened application keeps the change log in its data directory', async () => {
  const dataDir = directory();
  const app = openFederatedGraphApplication({ runtimeConfigPath: join(dataDir, 'graph-runtime.json'), env: {}, config,
    fetchImpl: async (_url, options = {}) => ((options.method ?? 'GET') === 'GET'
      ? Response.json({ detail: 'personal project not found' }, { status: 404 })
      : Response.json({ project_id: 'p', personal_space_id: SPACE, profile: JSON.parse(options.body).profile })) });
  try {
    await save(app, PERSON_WRITER, {});
    assert.equal(history(app).entries.length, 1);
    assert.equal(existsSync(join(dataDir, 'project-change-log.sqlite')), true);
  } finally {
    await app.close();
  }
});
