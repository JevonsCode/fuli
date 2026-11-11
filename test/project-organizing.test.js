import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleProjectOrganizingRequest } from '../src/http/project-organizing-api-router.js';
import { organizeProject } from '../src/project-organizing/agent-tool.js';
import { modelTier } from '../src/project-organizing/model-tiers.js';
import { createProjectOrganizing } from '../src/project-organizing/port.js';

// 整理 (rec#114): the coverage and run reports of a project. Synthetic
// projects and counts; no knowledge is read or written here.

function application(t, { project = 'synthetic-project' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-organizing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let tick = 0;
  return { config: { personal: { spaceId: 'synthetic-space' } },
    projectOrganizing: createProjectOrganizing({ path: join(directory, 'project-organizing.json'),
      now: () => new Date(Date.UTC(2026, 10, 11, 9, 0, tick++)) }),
    taskContextRegistry: { context: async token => ({ token, personalProjectId: project, projectAgentId: 'lead' }) } };
}

const call = (app, input) => organizeProject(app, { taskContextToken: 'turn-1', ...input });

test('a project nobody organised yet reads as nine missing areas, with what the model should attempt', async (t) => {
  const app = application(t);
  const first = await call(app, { action: 'read', model: 'synthetic-opus-9' });
  assert.equal(first.first_run, true);
  assert.deepEqual(first.progress, { settled: 0, total: 9, complete: false });
  assert.equal(first.areas.length, 9);
  assert.deepEqual(first.areas[0], { id: 'purpose', name: '这个项目是什么、给谁用', status: 'missing' });
  assert.equal(first.open.length, 9);
  assert.equal(first.last_run, null);
  assert.equal(first.model.tier, 'strong');
  assert.match(first.guidance, /do not interview the person/);
  // A small or unrecognised model is told to do less, or that FULI cannot tell.
  assert.match((await call(app, { action: 'read', model: 'synthetic-haiku' })).model.advice, /do not merge or judge/);
  assert.match((await call(app, { action: 'read' })).model.advice, /does not know this model/);
});

test('a run records what it settled, the sources it read and its counts; the next read goes on from there', async (t) => {
  const app = application(t);
  const saved = await call(app, { action: 'update',
    areas: { purpose: { status: 'known', note: ' From the README\n' }, stack: { status: 'unsure' }, people: { status: 'not_applicable' } },
    sources: { project_files: 'read', client_memories: 'declined' },
    run: { model: 'synthetic-sonnet', scope: 'release steps', added: 12, merged: 2, stale: 1, unsure: 3 } });
  assert.deepEqual(saved.progress, { settled: 2, total: 9, complete: false });
  assert.equal(saved.guidance, undefined, 'an update answers ids and states only');
  assert.deepEqual(saved.areas.slice(0, 2), [{ id: 'purpose', status: 'known', note: 'From the README' }, { id: 'stack', status: 'unsure' }]);
  // Unsure areas come before missing ones: a yes or no settles them.
  assert.deepEqual(saved.open.slice(0, 2), ['stack', 'run']);
  assert.deepEqual(saved.last_run, { at: '2026-11-11T09:00:00.000Z', model: 'synthetic-sonnet', tier: 'medium', scope: 'release steps',
    added: 12, merged: 2, stale: 1, unsure: 3 });
  const again = await call(app, { action: 'read' });
  assert.equal(again.first_run, false);
  assert.deepEqual(again.sources, { project_files: 'read', client_memories: 'declined' });
  // A later run changes only what it names and keeps the earlier report behind it.
  await call(app, { action: 'update', areas: { stack: { status: 'known' } }, run: { added: 1 } });
  const view = app.projectOrganizing.view('synthetic-space', 'synthetic-project');
  assert.deepEqual([view.progress.settled, view.runs.length, view.runs[0].added, view.runs[1].added], [3, 2, 1, 12]);
  assert.equal(view.runs[0].tier, 'unknown');
});

test('each project keeps its own coverage, and ten runs are kept', async (t) => {
  const app = application(t);
  for (let index = 0; index < 12; index += 1) await call(app, { action: 'update', run: { added: index } });
  assert.deepEqual(app.projectOrganizing.view('synthetic-space', 'synthetic-project').runs.map(run => run.added),
    [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(app.projectOrganizing.view('synthetic-space', 'another-project').started, false);
});

test('what is not an area, a source or a count is refused, and so is a task outside every project', async (t) => {
  const app = application(t);
  await assert.rejects(call(app, { action: 'update', areas: { budget: { status: 'known' } } }), /Unknown area: budget/);
  await assert.rejects(call(app, { action: 'update', areas: { purpose: { status: 'done' } } }), /areas\.purpose\.status is one of/);
  await assert.rejects(call(app, { action: 'update', sources: { browser_history: 'read' } }), /Unknown source/);
  await assert.rejects(call(app, { action: 'update', run: { added: -1 } }), /run\.added is a whole number/);
  await assert.rejects(call(app, { action: 'update' }), /Send areas, sources, run or several/);
  await assert.rejects(organizeProject(application(t, { project: null }), { action: 'read', taskContextToken: 'turn-1' }),
    error => error.code === 'project_unresolved');
  await assert.rejects(organizeProject({ config: app.config }, { action: 'read', taskContextToken: 'turn-1' }),
    error => error.code === 'project_organizing_unavailable');
});

test('a model is placed only when its family leaves no doubt', () => {
  assert.deepEqual(['synthetic-opus-9', 'claude-fable-5-2', 'synthetic-sonnet-9', 'synthetic-haiku-9', 'synthetic-opus-mini',
    'local-model:4b', 'gpt-9-preview', '', null].map(modelTier),
  ['strong', 'strong', 'medium', 'weak', 'weak', 'weak', 'unknown', 'unknown', 'unknown']);
});

test('the console reads a project in its own space and changes nothing', async (t) => {
  const app = application(t);
  await call(app, { action: 'update', areas: { purpose: { status: 'known' } } });
  const get = async (query, method = 'GET') => {
    const sent = {};
    const response = { setHeader() {}, writeHead(status) { sent.status = status; }, end(text) { sent.body = text ? JSON.parse(text) : null; } };
    const handled = await handleProjectOrganizingRequest({ request: { method }, response,
      url: new URL(`/api/project-organizing?${query}`, 'http://127.0.0.1'), app });
    return { handled, ...sent };
  };
  const read = await get('personalSpaceId=synthetic-space&personalProjectId=synthetic-project');
  assert.deepEqual([read.status, read.body.progress.settled, read.body.areas[0].zh], [200, 1, '这个项目是什么、给谁用']);
  assert.equal((await get('personalSpaceId=synthetic-space&personalProjectId=synthetic-project', 'POST')).status, 405);
  await assert.rejects(get('personalSpaceId=other-space&personalProjectId=synthetic-project'), error => error.code === 'scope_mismatch');
  await assert.rejects(get('personalSpaceId=synthetic-space'), /personalProjectId is required/);
});
