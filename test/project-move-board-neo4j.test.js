import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { JefaBoardStore } from '../src/employees/builtin/jefa/board-store.js';
import { RunnerHostStore } from '../src/runner/host-store.js';
import { RunnerStore, RUNNER_FILE } from '../src/runner/runner-store.js';
import { MoveStore, PROJECT_MOVES_FILE } from '../src/runner/move-store.js';
import { projectMoveCoordinator } from '../src/runner/project-move.js';
import { gateDirectory, holdProjectWrites, initializeProjectGate } from '../src/runner/project-write-gate.js';
import { cypher, enabled, startReplicaTestProvider } from '../test-support/replica-neo4j.js';

const host = 'a'.repeat(64), peer = 'b'.repeat(64);
const project = 'handover-acceptance';

function participant(input) {
  return new Promise((resolve, reject) => {
    const child = fork(new URL('../test-support/move-board-child.js', import.meta.url), [], { stdio: ['ignore','ignore','ignore','ipc'] });
    let result;
    child.once('message', answer => { result = answer; });
    child.once('error', reject);
    child.once('exit', (_code, signal) => {
      if (signal === 'SIGKILL' && input.interrupt) resolve({ ok: false, code: 'test_interrupted' });
      else if (result) resolve(result);
      else reject(new Error('Participant exited without a phase receipt'));
    });
    child.send(input);
  });
}

test('both transfer directions recover from interruptions after durable graph, decision, board and route writes',
  { skip: !enabled || !process.env.FULI_TEST_FOLLOWER_NEO4J_URI, timeout: 300_000 }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'fuli-project-handover-'));
    const dirs = { [host]: join(root,'host'), [peer]: join(root,'peer') };
    const uris = { [host]: process.env.FULI_TEST_NEO4J_URI, [peer]: process.env.FULI_TEST_FOLLOWER_NEO4J_URI };
    assert.notEqual(uris[host], uris[peer]);
    const stops = [];
    const open = (device, moveInstallation) => startReplicaTestProvider({ replica: device === peer, uri: uris[device],
      moveInstallation, onStop: stop => stops.push(stop) });
    const configured = {}, accounts = {}, boards = {};
    let control, db;
    t.after(async () => {
      for (const stop of stops.reverse()) await stop();
      for (const board of Object.values(boards)) board.close();
      control?.close(); db?.close(); rmSync(root, { recursive: true, force: true });
    });
    const follower = new RunnerStore(join(dirs[peer], RUNNER_FILE));
    try { follower.db.prepare('SELECT 1').get(); } finally { follower.close(); }
    const initial = {};
    for (const device of [host, peer]) {
      initial[device] = await open(device);
      accounts[device] = (await initial[device].request('/v1/bootstrap', { principal_name: 'Synthetic move fixture' })).access_token;
    }
    // The runner acceptance immediately before this case already paired these two disposable graphs.
    const prior = await cypher("MATCH (s:FuliSpace {kind:'personal',name:'Synthetic paired project'}) RETURN s.id AS space", {}, uris[peer]);
    const space = prior[0]?.space ?? (await initial[host].request('/v1/spaces', { kind: 'personal', name: 'Synthetic move fixture' },
      { token: accounts[host] })).id;
    if (!prior.length) await initial[peer].request('/v1/spaces', { kind: 'personal', id: space,
      provider_id: 'global-copy-acceptance', name: 'Synthetic move fixture' }, { token: accounts[peer] });
    await initial[peer].request('/v1/personal-projects', { personal_space_id: space, project_id: project,
      profile: { name: project, purpose: 'Synthetic transfer.', lifecycle: 'active' } }, { token: accounts[peer], method: 'PUT' });
    for (const device of [host, peer]) {
      await initial[device].stop();
      initializeProjectGate(gateDirectory(dirs[device], space), project, device === peer ? 'owner' : 'vacant', 1);
      boards[device] = new JefaBoardStore(join(dirs[device], 'board.sqlite'));
      configured[device] = await open(device, { dir: dirs[device], space, device, authority: host });
    }
    const scope = { spaceId: space, projectId: project };
    boards[peer].setSharing(scope, true);
    const sealedBoard = boards[peer].exportForMove(scope).digest;
    control = new RunnerHostStore(join(dirs[host], 'runner', 'host.sqlite'), { spaceId: () => space });
    control.invite({ code: 'test-move-pair', name: 'B' });
    control.pair({ code: 'test-move-pair', fingerprint: peer });
    const registry = control.ownership();
    registry.verified(host, []); registry.verified(peer, [project]);
    db = new MoveStore(join(dirs[host], PROJECT_MOVES_FILE));
    // Interrupt after the durable external effect but before its progress receipt.
    const points = { stage: ['stage'], activate: ['promote', 'install-board', 'target-route'], forward: ['demote', 'source-route'] };
    const interrupted = new Set();
    const decide = registry.decidePairedMove.bind(registry);
    registry.decidePairedMove = (authority, move, decision) => {
      const result = decide(authority, move, decision);
      if (result.ok && decision === 'committed' && !interrupted.has(move.move_id + decision)) {
        interrupted.add(move.move_id + decision);
        throw Object.assign(new Error('Lost decision receipt'), { code: 'test_interrupted' });
      }
      return result;
    };
    const invoke = async (device, phase, move, input) => {
      const point = points[phase]?.find(name => !interrupted.has(move.move_id + name));
      const result = await participant({ device, phase, move, input, authority: host,
        dir: dirs[device], ticket: coordinator.ticket(move), uri: configured[device].url,
        token: accounts[device], interrupt: point });
      if (result.code === 'test_interrupted') interrupted.add(move.move_id + point);
      return result;
    };
    const coordinator = projectMoveCoordinator({ store: db, registry, dataDir: dirs[host], space, authority: host,
      pairing: device => control.grants(device).pairing(), invoke, verifyCopy: async move => {
        const old = await invoke(move.source, 'verify_copy', move);
        const writable = await invoke(move.target, 'verify_copy', move);
        return old.ok && writable.ok && old.owner === move.target && writable.owner === null && old.digest === writable.digest;
      } });
    for (const [index, target] of [host,peer].entries()) {
      const move = coordinator.start({ project, target, reason: 'Transfer the synthetic board', moveId: 'graph-move-' + index });
      let row = move;
      for (let attempts = 0; attempts < 100 && row.step !== 'done'; attempts++) {
        try { row = await coordinator.advance(move); }
        catch (error) {
          assert.equal(error.code, 'test_interrupted');
          const writers = Object.keys(dirs).filter(device => {
            try { holdProjectWrites(gateDirectory(dirs[device], space), [project])(); return true; }
            catch { return false; }
          });
          assert.ok(writers.length <= 1);
          if (writers.length) assert.equal(writers[0], registry.owner(project).owner);
          if (interrupted.has(move.move_id + 'promote') && !interrupted.has(move.move_id + 'install-board')) {
            const actual = await cypher('MATCH (:FuliSpace {id:$space})-[:CONTAINS_PROJECT]->(p:FuliPersonalProject {project_id:$project}) RETURN p.fuli_replica_owner AS owner',
              { space, project }, uris[target]);
            assert.deepEqual(actual.map(row => row.owner), [null]);
            if (index === 0) assert.notEqual(boards[target].exportForMove(scope).digest, sealedBoard);
            assert.deepEqual(writers, []);
          }
        }
      }
      assert.equal(row.step, 'done');
      assert.equal(boards[target].exportForMove(scope).digest, sealedBoard);
      assert.equal(registry.owner(project).owner, target);
      assert.equal(registry.owner(project).generation, index + 2);
    }
    assert.equal(interrupted.size, 2 * (1 + Object.values(points).flat().length));
  });
