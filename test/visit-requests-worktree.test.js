import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

import { createVisitorAccess } from '../src/visitor-access/port.js';
import { createVisitRequests } from '../src/visit-requests/service.js';
import { createVisitRunner } from '../src/visit-requests/runner.js';

// A temporary Git repository made by the test, a fake wake that edits files
// the way a client would, and nothing else: no client, no data directory.
const PEER = `peer:${'d'.repeat(64)}`;
const SAFE_PLAN = { areas: ['src/server.js'], risks: [], dependencyChanges: false, configChanges: false, network: false, size: 's' };
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', '-c', 'user.name=Synthetic owner', '-c', 'user.email=owner@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });

function ownerRepository(t) {
  const root = mkdtempSync(join(tmpdir(), 'visitreq-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repository = join(root, 'project');
  mkdirSync(join(repository, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', repository);
  writeFileSync(join(repository, 'src', 'server.js'), 'const port = 4100;\n');
  writeFileSync(join(repository, 'package-lock.json'), '{"lockfileVersion": 3}\n');
  git(repository, 'add', '-A');
  git(repository, 'commit', '-q', '-m', 'synthetic start');
  git(repository, 'branch', 'feature');
  // The owner's own work in progress: never seen by the visit, never touched.
  writeFileSync(join(repository, 'src', 'server.js'), 'const port = 4100; // owner editing\n');
  writeFileSync(join(repository, 'notes.txt'), 'owner notes\n');
  return { root, repository };
}

// What the owner's checkout looks like to Git: working tree status and every ref outside fuli/visit/*.
function ownerState(repository) {
  return { status: git(repository, 'status', '--porcelain=v1', '--untracked-files=all'),
    refs: git(repository, 'for-each-ref', '--format=%(refname) %(objectname)').split('\n').filter((line) => line && !line.includes('fuli/visit/')) };
}

function service(t, { root, repository }, edit, { plan = SAFE_PLAN, mode = 'trusted' } = {}) {
  const wakes = [];
  const runner = createVisitRunner({ root: join(root, 'visit-worktrees'), projectFolder: async () => repository,
    verifyFolder: async (folder) => folder === repository,
    wake: async (input) => {
      wakes.push({ mode: input.mode, cwd: input.cwd, timeoutMs: input.timeoutMs, prompt: input.prompt });
      if (input.mode === 'read_only') return { body: `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`` };
      edit(input.cwd, repository);
      return { body: 'Moved the port into settings.' };
    } });
  let sequence = 0;
  const port = createVisitorAccess({ application: {},
    requests: ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner, idFactory: () => `visitreq-${++sequence}` }) });
  t.after(() => port.close());
  port.setRequesterMode({ key: PEER, kind: 'peer', label: 'Synthetic laptop', mode, ownDevice: mode === 'trusted' });
  const submit = () => port.submitRequest({ requester: { key: PEER, label: 'Synthetic laptop' }, projectId: 'synthetic-project',
    agentId: 'synthetic-lead', request: { title: 'Port from settings', what: 'Read the port from settings.' } });
  return { port, wakes, submit };
}

async function reviewed(port, id) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const { request } = await port.requests.card(id);
    if (!['received', 'planning', 'approved', 'running'].includes(request.state)) return request;
    await delay(10);
  }
  assert.fail('the request did not finish');
}

test('a run edits only its worktree on its branch; the owner\'s working tree and other refs stay exactly as they were',
  { timeout: 60_000 }, async (t) => {
    const owner = ownerRepository(t);
    const before = ownerState(owner.repository);
    const head = git(owner.repository, 'rev-parse', 'HEAD').trim();
    const f = service(t, owner, (worktree) => writeFileSync(join(worktree, 'src', 'server.js'),
      'import settings from "./settings.js";\nconst port = settings.port;\n'));
    const { requestId } = f.submit();
    const request = await reviewed(f.port, requestId);
    assert.deepEqual([request.state, request.review, request.holdReason], ['awaiting_review', 'ready', null]);
    assert.deepEqual(ownerState(owner.repository), before, 'status and refs of the owner are unchanged');
    assert.equal(git(owner.repository, 'rev-parse', 'HEAD').trim(), head);
    assert.match(readFileSync(join(owner.repository, 'src', 'server.js'), 'utf8'), /owner editing/);

    // The worktree started from the commit, without the owner's uncommitted work.
    assert.equal(request.baseCommit, head);
    assert.deepEqual(request.files, [{ path: 'src/server.js', added: 2, removed: 1 }]);
    assert.deepEqual(request.diffstat, { files: 1, added: 2, removed: 1 });
    const author = git(owner.repository, 'log', '-1', '--format=%an <%ae>', `refs/heads/${request.branch}`).trim();
    assert.equal(author, 'FULI visit <visit@fuli.invalid>');
    // The planning pass was read-only and capped at 3 minutes; the run edited its own worktree in 15.
    assert.deepEqual(f.wakes.map((wake) => [wake.mode, wake.cwd, wake.timeoutMs]),
      [['read_only', request.worktreePath, 180_000], ['worktree_edit', request.worktreePath, 900_000]]);
    assert.match(f.wakes[0].prompt, /<visit-request>\n\{"title":"Port from settings"/);

    const card = await f.port.requests.card(requestId);
    assert.match(card.diff.text, /\+const port = settings\.port;/);
    await f.port.requests.discard(requestId);
    assert.equal(existsSync(request.worktreePath), false);
    assert.equal(git(owner.repository, 'branch', '--list', request.branch).trim(), '', 'discard deletes the branch');
    assert.deepEqual(ownerState(owner.repository), before);
  });

test('keep removes the worktree and keeps the branch', { timeout: 60_000 }, async (t) => {
  const owner = ownerRepository(t);
  const f = service(t, owner, (worktree) => writeFileSync(join(worktree, 'README.md'), '# Synthetic\n'));
  const { requestId } = f.submit();
  const request = await reviewed(f.port, requestId);
  await f.port.requests.keep(requestId);
  assert.equal(existsSync(request.worktreePath), false);
  assert.equal(git(owner.repository, 'branch', '--list', request.branch).trim().replace(/^[*+ ]+/, ''), request.branch);
});

test('auto decides from the actual diff: a plan injected as safe plus a lockfile edit ends held', { timeout: 60_000 }, async (t) => {
  const owner = ownerRepository(t);
  const f = service(t, owner, (worktree) => writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion": 3, "x": 1}\n'),
    { mode: 'auto' });
  const { requestId } = f.submit();
  const request = await reviewed(f.port, requestId);
  assert.deepEqual([request.state, request.review, request.holdReason], ['awaiting_review', 'held', 'outside_envelope']);
  const decision = (await f.port.requests.card(requestId)).events.at(-1);
  assert.equal(decision.checks.find((check) => check.name === 'no_denied_paths').ok, false);
  assert.equal(f.port.requestStatus({ requester: { key: PEER }, requestId }).state, 'awaiting_owner');
});

test('a run that touches the owner\'s checkout is held as an integrity violation', { timeout: 60_000 }, async (t) => {
  const owner = ownerRepository(t);
  const f = service(t, owner, (worktree, repository) => {
    writeFileSync(join(worktree, 'src', 'server.js'), 'const port = 4200;\n');
    writeFileSync(join(repository, 'src', 'server.js'), 'tampered\n');
  });
  const { requestId } = f.submit();
  const request = await reviewed(f.port, requestId);
  assert.deepEqual([request.review, request.holdReason], ['held', 'integrity_violation']);
});
