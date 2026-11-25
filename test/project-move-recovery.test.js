import { setTimeout as delay } from 'node:timers/promises';
import { createRunnerHost } from '../src/runner/host-service.js';
import { movedTask } from '../src/runner/moved-task.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { RunnerStore, RUNNER_FILE } from '../src/runner/runner-store.js';
import { holdReason } from '../src/runner/global-writes-outbox.js';
import { moveParticipant } from '../src/runner/move-participant.js';
import { MoveStore, PROJECT_MOVES_FILE, savedMoveHistory } from '../src/runner/move-store.js';
import { projectMoveCoordinator } from '../src/runner/project-move.js';
import { gateDirectory, holdProjectWrites, initializeProjectGate, readProjectGate } from '../src/runner/project-write-gate.js';

const host = 'a'.repeat(64), peer = 'b'.repeat(64), space = 'synthetic-space', project = 'sample';
const graphDigest = 'd'.repeat(64);
const token = 'synthetic-task';
const history = { labels: ['FuliTaskContext'], properties: { token, personal_project_id: project } };
const graphText = '{"envelope":{"nodes":[' + JSON.stringify(history) + ']},"value":12345678901234567890,"large":"' + '界'.repeat(21_000) + '"}';

function computers(t, { loseReplies = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fuli-move-'));
  const dirs = { [host]: join(root,'host'), [peer]: join(root,'peer') };
  const control = new RunnerHostStore(join(dirs[host], 'runner', 'host.sqlite'), { spaceId: () => space });
  const invite = 'move-test-pairing';
  control.invite({ code: invite, name: 'test' });
  control.pair({ code: invite, fingerprint: peer });
  const registry = control.ownership();
  registry.verified(host, ['unrelated']);
  registry.verified(peer, [project]);
  const graphs = { [peer]: { owner: null, text: graphText }, [host]: null };
  const runner = new RunnerStore(join(dirs[peer], RUNNER_FILE));
  runner.db.prepare('SELECT 1').get();
  t.after(() => runner.close());
  const lost = new Set();
  for (const [device, dir] of Object.entries(dirs)) {
    initializeProjectGate(gateDirectory(dir, space), 'unrelated', 'owner', 1);
    writeFileSync(join(dir, 'runner', 'project-registry.json'), JSON.stringify({ version: 1, spaceId: space, device, authority: host }));
    if (device === peer) initializeProjectGate(gateDirectory(dir, space), project, 'owner', 1);
  }
  t.after(() => { control.close(); rmSync(root, { recursive: true, force: true }); });
  function exercise(work) {
    const stores = new Map(Object.entries(dirs).map(([device, dir]) => [device, new MoveStore(join(dir, PROJECT_MOVES_FILE))]));
    const boards = new Map(Object.entries(dirs).map(([device, dir]) => [device, new JefaBoardStore(join(dir, 'board.sqlite'))]));
    const routes = new Map();
    const coordinator = projectMoveCoordinator({ store: stores.get(host), registry, dataDir: dirs[host], space, authority: host,
      paired: device => Boolean(control.grants(device).pairing()),
      pairing: device => control.grants(device).allowed('project:' + project) ? control.grants(device).pairing() : null, verifyCopy: move => graphs[move.source]?.owner === move.target,
      invoke: async (device, action, move, input) => {
        if (device === peer && !control.grants(peer).pairing()) throw Object.assign(new Error(), { code: 'move_waiting_for_participant' });
        const run = moveParticipant({ store: stores.get(device), dataDir: dirs[device], device, space, authority: host,
          inspect: async () => graphs[device] ? { digest: graphDigest, owner: graphs[device].owner } : { empty: true },
          board: boards.get(device), decision: m => coordinator.ticket(m, device === host),
          installRoute: async (m, here) => routes.set(device, here ? device : m.target),
          handover: async ({ phase, bundle }) => {
            const entry = stores.get(device).participant(move);
            assert.equal(entry.allowed_action, phase);
            assert.equal(readProjectGate(gateDirectory(dirs[device], space), project).state, 'closed');
            const image = graphs[device];
            if (phase === 'baseline' || phase === 'seal') return image ? { digest: graphDigest, text: image.text } : { empty: true };
            if (phase === 'stage' || phase === 'restore') {
              assert.equal(bundle, graphText);
              graphs[device] = { owner: move.source, text: bundle };
            }
            if (phase === 'promote') image.owner = null;
            if (phase === 'demote') image.owner = move.target;
            if (phase === 'discard') graphs[device] = null;
            return { ok: true, digest: graphDigest };
          } });
        const result = await run(action, move, input);
        const event = [move.move_id,device,action,input?.kind,input?.position].join('/');
        if (loseReplies && !lost.has(event)) { lost.add(event); throw Object.assign(new Error(), { code: 'owner_result_unknown' }); }
        return result;
      } });
    return Promise.resolve().then(() => work(coordinator, stores.get(host))).finally(() => {
      for (const db of [...stores.values(), ...boards.values()]) db.close();
    });
  }
  function writers() {
    return Object.entries(dirs).flatMap(([device, dir]) => {
      const directory = gateDirectory(dir, space);
      holdProjectWrites(directory, ['unrelated'])();
      try { holdProjectWrites(directory, [project])(); return [device]; } catch { return []; }
    });
  }
  return { exercise, writers, registry, graphs, lost, dirs, runner, control };
}

test('reopening every store and losing every participant reply preserves one writer, in both directions', async t => {
  const { exercise, writers, registry, lost, dirs } = computers(t, { loseReplies: true });
  for (const [index, target] of [host, peer].entries()) {
    const move = await exercise(c => c.start({ project, target, reason: 'Move this synthetic project', moveId: 'request-' + index }));
    let done = false;
    for (let attempt = 0; attempt < 180 && !done; attempt++) {
      try { done = (await exercise(c => c.advance(move))).step === 'done'; }
      catch (error) { assert.equal(error.code, 'owner_result_unknown', error.stack); }
      const current = writers();
      assert.ok(current.length <= 1);
      if (current.length) assert.equal(current[0], registry.owner(project).owner);
    }
    assert.ok(done);
    const history = savedMoveHistory(dirs[host], registry, space);
    assert.ok(history.some(row => row.moveId === move.move_id && row.decision === 'committed' && row.step === 'done'));
    assert.equal(savedMoveHistory(dirs[host], registry, space, { project, id: move.move_id }).target, target);
    registry.reported(move.source, [project]);
    assert.equal(registry.verified(move.source, [project]).ok, true);
    assert.equal(registry.owner(project).state, 'owned');
    assert.equal(registry.owner(project).owner, target);
    for (const dir of Object.values(dirs)) {
      assert.equal(movedTask(dir, token).target, target);
      assert.equal(movedTask(dir, 'a-different-task'), null);
    }
    assert.deepEqual(writers(), [target]);
    assert.equal(registry.owner(project).generation, index + 2);
  }
  assert.ok(lost.size > 24);
  for (const replacement of [{ spaceId: 'another-space' }, { authority: 'c'.repeat(64) }, { device: host }]) {
    writeFileSync(join(dirs[peer], 'runner', 'project-registry.json'), JSON.stringify({
      version: 1, spaceId: space, device: peer, authority: host, ...replacement
    }));
    assert.deepEqual(movedTask(dirs[peer], token), {});
  }
});

test('a durable abort restores the prior source and removes only a staged empty target', async t => {
  const { exercise, writers, graphs, registry } = computers(t);
  const move = await exercise(c => c.start({ project, target: host, reason: 'Move sample', moveId: 'abort-sample' }));
  let phase;
  for (let i = 0; i < 40 && phase !== 'verified'; i++) phase = (await exercise(c => c.advance(move))).step;
  assert.equal(phase, 'verified');
  assert.deepEqual(writers(), []);
  assert.equal((await exercise(c => c.advance(move, true))).step, 'aborted');
  assert.deepEqual(writers(), [peer]);
  assert.equal(graphs[host], null);
  assert.equal(registry.owner(project).generation, 1);
});

test('a claimed checkpoint and a held global write block sealing, late work stays at source', async t => {
  const { exercise, runner } = computers(t);
  const checkpoint = { id: 'waiting', tool: 'checkpoint_task_context', input: { taskContextToken: token }, sourceApplication: 'codex' };
  runner.enqueue(checkpoint);
  assert.equal(runner.claimNext().id, checkpoint.id);
  runner.enqueue({ ...checkpoint, id: 'held', tool: 'global_writes', input: { ops: [{ input: { taskId: token } }] },
    heldFor: holdReason('synthetic-old-host') });
  const move = await exercise(c => c.start({ project, target: host, reason: 'Transfer sample', moveId: 'outbox-test' }));
  let step;
  for (let i = 0; i < 5 && step !== 'frozen'; i++) step = (await exercise(c => c.advance(move))).step;
  assert.equal(step, 'frozen');
  await assert.rejects(exercise(c => c.advance(move)), { code: 'project_outbox_pending' });
  runner.delivered(checkpoint.id);
  await assert.rejects(exercise(c => c.advance(move)), { code: 'project_outbox_pending' });
  runner.delivered('held');
  assert.equal((await exercise(c => c.advance(move))).step, 'graph');
  runner.enqueue({ ...checkpoint, id: 'late' });
  assert.equal(runner.entry('late').reason, 'project_move_frozen');
  assert.deepEqual(runner.entry('late').input, checkpoint.input);
  runner.enqueue({ ...checkpoint, id: 'unrelated', input: { taskContextToken: 'another-task' } });
  assert.equal(runner.claimNext().id, 'unrelated');
  await exercise(c => c.advance(move, true));
  runner.enqueue({ ...checkpoint, id: 'after-abort' });
  assert.equal(runner.entry('after-abort').state, 'queued');
});

test('a local decision can finish waiting for a revoked peer only after durable abort', async t => {
  const { exercise, registry, control } = computers(t);
  const move = await exercise(c => c.start({ project, target: host, reason: 'Synthetic transfer', moveId: 'close-aborted' }));
  const started = await exercise(c => c.advance(move));
  await assert.rejects(exercise(c => c.advance(started, false, true)), { code: 'move_abandon_unavailable' });
  control.revoke(peer);
  await assert.rejects(exercise(c => c.advance(started)), { code: 'move_waiting_for_participant' });
  const closed = await exercise(c => c.advance(started, false, true));
  assert.equal(closed.step, 'aborted');
  assert.equal(closed.last_error, 'move_peer_ack_abandoned');
  assert.equal(registry.moveDecision(project, move.move_id).decision, 'aborted');
  assert.equal(registry.owner(project).owner, peer);
});

for (const stage of ['target_frozen', 'graph', 'verified', 'committed', 'source_at_host']) {
  test('a revoked pairing recovers the durable decision at ' + stage, async t => {
    const { exercise, writers, registry, control } = computers(t);
    const start = (target, moveId) => exercise(c => c.start({ project, target, reason: 'Move the test project', moveId }));
    async function through(row, target) {
      for (let i = 0; i < 80 && row.step !== target; i++) {
        row = await exercise(c => c.advance(row));
        const current = writers();
        assert.ok(current.length <= 1);
        if (current.length) assert.equal(current[0], registry.owner(project).owner);
      }
      assert.equal(row.step, target);
      return row;
    }
    const fromHost = stage === 'source_at_host';
    if (fromHost) await through(await start(host, 'initial-transfer'), 'done');
    const move = await start(fromHost ? peer : host, 'interrupted');
    const row = await through(move, fromHost ? 'graph' : stage);
    control.revoke(peer);
    if (stage === 'committed') {
      assert.equal((await exercise(c => c.advance(row))).step, 'activated');
      assert.deepEqual(writers(), [host]);
    }
    await assert.rejects(exercise(c => c.advance(row)), { code: 'move_waiting_for_participant' });
    if (fromHost) assert.deepEqual(writers(), [host]);
    assert.equal(registry.moveDecision(project, row.move_id).decision, stage === 'committed' ? 'committed' : 'aborted');
    control.invite({ code: 'replacement-invitation', name: 'Returned computer' });
    control.pair({ code: 'replacement-invitation', fingerprint: peer });
    assert.notEqual(control.grants(peer).pairing(), row.pairing);
    await through(row, stage === 'committed' ? 'done' : 'aborted');
    const owner = fromHost || stage === 'committed' ? host : peer;
    assert.deepEqual(writers(), [owner]);
    await through(await start(owner === host ? peer : host, 'next-transfer'), 'done');
  });
}

test('a restarted host settles its local abort with its last runner revoked and no network listener', async t => {
  const { exercise, control, dirs, writers, registry } = computers(t);
  async function leaveAt(target, stage, id) {
    const move = await exercise(c => c.start({ project, target, reason: 'Test local recovery', moveId: id }));
    let row = move;
    for (let i = 0; i < 80 && row.step !== stage; i++) row = await exercise(c => c.advance(move));
    assert.equal(row.step, stage);
    return move;
  }
  await leaveAt(host, 'done', 'first');
  const move = await leaveAt(peer, 'graph', 'second');
  control.revoke(peer);
  const app = { config: { personal: { spaceId: space } } };
  const service = createRunnerHost({ dataDir: dirs[host], app, projectCopies: true, projectMoves: true,
    loadIdentity: async () => ({ fingerprint: host }), discoverAddresses: () => [] });
  try {
    await service.start();
    for (let i = 0; i < 100 && !writers().includes(host); i++) await delay(20);
    assert.equal(service.list().listening, false);
    assert.equal(registry.moveDecision(project, move.move_id).decision, 'aborted');
    assert.deepEqual(writers(), [host]);
  } finally { await service.close(); }
});
