import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApplication } from '../src/app/create-application.js';
import { createServer } from '../src/server.js';
import { FileStore } from '../src/store.js';
import { closeServer, getJson, postJson } from '../test-support/server.js';

test('web API lets user make a lightweight candidate decision', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    sourceKind: 'chat',
    body: '可能这个模块以后要拆出去'
  });
  const before = await getJson(`${url}/api/state`);
  const candidate = before.candidates[0];

  const decision = await postJson(`${url}/api/candidates/${candidate.id}/decision`, {
    decision: 'sync'
  });
  const after = await getJson(`${url}/api/state`);

  assert.equal(decision.candidate.status, 'synced');
  assert.equal(after.candidates[0].status, 'synced');
  assert.equal(
    after.episodes.some(
      (episode) =>
        episode.spaceId === project.space.id && episode.body === '可能这个模块以后要拆出去'
    ),
    true
  );
});

test('syncing a candidate publishes extracted project facts', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  await postJson(`${url}/api/subscriptions`, {
    personalSpaceId: personal.space.id,
    spaceId: project.space.id
  });
  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    sourceKind: 'chat',
    sourceUri: 'chat://candidate',
    body: 'test_url: https://candidate.example.com'
  });
  const before = await getJson(`${url}/api/state`);

  await postJson(`${url}/api/candidates/${before.candidates[0].id}/decision`, {
    decision: 'sync'
  });
  const search = await getJson(
    `${url}/api/search?personalSpaceId=${personal.space.id}&q=candidate.example`
  );

  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].spaceName, 'Project A');
  assert.equal(search.matches[0].fact.object, 'https://candidate.example.com');
  assert.equal(search.matches[0].source.uri, 'chat://candidate');
});

test('keeping a candidate personal publishes extracted personal facts', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  await postJson(`${url}/api/remember`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    sourceKind: 'chat',
    sourceUri: 'chat://local',
    body: 'local_alias: pnpm dev'
  });
  const before = await getJson(`${url}/api/state`);

  await postJson(`${url}/api/candidates/${before.candidates[0].id}/decision`, {
    decision: 'personal_only'
  });
  const search = await getJson(`${url}/api/search?personalSpaceId=${personal.space.id}&q=local_alias`);

  assert.equal(search.matches.length, 1);
  assert.equal(search.matches[0].spaceName, 'Jevons');
  assert.equal(search.matches[0].fact.object, 'pnpm dev');
  assert.equal(search.matches[0].source.uri, 'chat://local');
});

test('web API observes git diff as automatic growth input', async (t) => {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'fuli-server-')), 'context.db');
  const repoPath = mkdtempSync(join(tmpdir(), 'fuli-server-repo-'));
  execFileSync('git', ['init'], { cwd: repoPath, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'fuli@example.com'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.name', 'Fuli Test'], { cwd: repoPath });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'prd.md'), '# Project A\n', 'utf8');
  execFileSync('git', ['add', 'prd.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'baseline'], { cwd: repoPath, stdio: 'ignore' });
  writeFileSync(join(repoPath, 'prd.md'), '# Project A\ntest_url: https://api.example.com\n', 'utf8');

  const { server, url } = await createServer({ dbPath, port: 0 });
  t.after(() => server.close());

  const personal = await postJson(`${url}/api/spaces`, { name: 'Jevons', kind: 'personal' });
  const project = await postJson(`${url}/api/spaces`, { name: 'Project A', kind: 'public' });
  const observed = await postJson(`${url}/api/observe/git-diff`, {
    personalSpaceId: personal.space.id,
    targetSpaceId: project.space.id,
    cwd: repoPath
  });
  const state = await getJson(`${url}/api/state`);

  assert.equal(observed.observed.length, 1);
  assert.equal(state.currentFacts[0].object, 'https://api.example.com');
});
