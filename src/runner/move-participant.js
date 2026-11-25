import { existsSync } from 'node:fs';
import { heldBecause } from './global-writes-outbox.js';
import { checkPendingMoveWork, sealWorkKeys } from './move-outbox.js';
import { RUNNER_FILE, RunnerStore } from './runner-store.js';
import { rememberMoveTasks } from './moved-task.js';
import { moveDecisions } from './move-wire.js';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { immediateTransaction } from '../../packages/roundtable/src/storage/database-format.js';
import { acquireFileLock } from '../storage/file-lock.js';
import { finishProjectGate, freezeProject, gateDirectory, initializeProjectGate, readProjectGate } from './project-write-gate.js';
import { movePackages } from './move-packages.js';
import { digestValue, moveError, moveKey, sameMove, validMove } from './move-store.js';

const keyWhere = ' WHERE space=? AND project=? AND move_id=?';
const terminalSteps = new Set(['activated','forwarded','aborted']);
const check = (ok, code) => { if (!ok) throw moveError(code); };
const exactSeal = seal => seal && digestValue(seal.graphDigest) && digestValue(seal.boardDigest) &&
  ['graph','board'].every(kind => digestValue(seal[kind]?.digest) && Number.isSafeInteger(seal[kind]?.bytes));

// 'decision' reads the authority's durable row over the pinned connection,
// or directly on the authority. Never infer a decision from a phase message.
export function moveParticipant({ store, dataDir, space, device, authority, decision, handover, inspect, board, installRoute }) {
  const db = store.db;
  const directory = gateDirectory(dataDir, space);
  async function run(action, move, input = {}) {
    check(validMove(move) && move.space === space && [move.source,move.target].includes(device) &&
      [move.source,move.target].includes(authority) && Object.hasOwn(moveDecisions, action), 'move_invalid');
    const source = device === move.source;
    const target = !source;
    if (['seal','forward','get_chunk'].includes(action)) check(source, 'move_wrong_participant');
    if (['stage','activate','put_chunk'].includes(action)) check(target, 'move_wrong_participant');
    const lock = createHash('sha256').update(JSON.stringify([space, move.project])).digest('hex');
    const release = acquireFileLock(join(dataDir, 'runner', 'move-locks', lock + '.lock'));
    try {
      const ticket = await decision(move);
      check(sameMove(move, ticket) && ticket.decision === moveDecisions[action], 'move_decision_unconfirmed');
      const key = moveKey(move);
      const scope = { spaceId: space, projectId: move.project };
      const files = movePackages(store, move);
      let row = store.participant(move);
      if (action === 'inspect' || action === 'verify_copy') {
        if (action === 'verify_copy') check(sameMove(row, move) &&
          row.step === (source ? 'forwarded' : 'activated'), 'move_phase_changed');
        const result = await inspect({ personalSpaceId: space, projectId: move.project, readiness: action === 'inspect' });
        if (result.empty && target && action === 'inspect') return { ok: true, empty: true };
        const expected = action === 'inspect' ? (source ? null : move.source) : (target ? null : move.target);
        check(digestValue(result.digest) && result.owner === expected, 'move_wrong_owner');
        return { ok: true, digest: result.digest, owner: result.owner };
      }
      if (!row) {
        if (action === 'abort') return { ok: true, step: 'aborted' };
        check(action === 'freeze', 'move_phase_changed');
        const gate = readProjectGate(directory, move.project);
        if (!gate && target) initializeProjectGate(directory, move.project, 'vacant', move.generation);
        const role = gate?.role ?? 'vacant';
        check(source ? role === 'owner' : ['vacant','replica'].includes(role), 'move_wrong_owner');
        row = store.enlist(move, role);
      }
      check(sameMove(row, move), 'move_changed');
      function progress(step) {
        db.prepare('UPDATE move_participants SET step=?, allowed_action=NULL' + keyWhere).run(step, ...key);
        row = store.participant(move);
      }
      async function graph(phase, bundle) {
        db.prepare('UPDATE move_participants SET allowed_action=?' + keyWhere).run(phase, ...key);
        return handover({ personalSpaceId: space, projectId: move.project, moveId: move.move_id, phase, bundle });
      }
      const receipt = () => ({ ok: true, step: row.step, ...(row.graph_digest ? {
        graphDigest: row.graph_digest, boardDigest: row.board_digest, graph: files.manifest('graph'), board: files.manifest('board')
      } : {}) });
      const gate = { generation: move.generation, moveId: move.move_id, role: row.gate_role };
      if (terminalSteps.has(row.step)) {
        check(({ activate: 'activated', forward: 'forwarded', abort: 'aborted' })[action] === row.step, 'move_phase_retired');
        return action === 'abort' ? { ok: true, step: 'aborted' } : receipt();
      }
      if (action === 'freeze') {
        if (row.step === 'requested') {
          freezeProject(directory, move.project, gate);
          progress('frozen');
        }
        return receipt();
      }
      if (action === 'seal') {
        if (row.step === 'sealed') return receipt();
        check(row.step === 'frozen', 'move_phase_changed');
        const first = await graph('seal');
        const second = await graph('seal');
        check(digestValue(first.digest) && first.digest === second.digest, 'move_graph_changed');
        const snapshot = board.exportForMove(scope);
        const workKeys = sealWorkKeys(move, first.text);
        const save = () => immediateTransaction(db, () => {
          const add = db.prepare('INSERT OR IGNORE INTO move_outbox_keys VALUES(?,?,?,?)');
          for (const hash of workKeys) add.run(hash, ...key);
          files.save('graph', first.text);
          rememberMoveTasks(db, move, first.text);
          files.save('board', JSON.stringify(snapshot));
          db.prepare('UPDATE move_participants SET graph_digest=?,board_digest=?' + keyWhere).run(first.digest, snapshot.digest, ...key);
          progress('sealed');
        });
        // The follower's queue is serialized with enqueue, claim and retry. An
        // in-flight claim remains queued until its authoritative reply arrives.
        const path = join(dataDir, RUNNER_FILE);
        if (existsSync(path)) {
          const runner = new RunnerStore(path);
          try {
            immediateTransaction(runner.db, () => {
              checkPendingMoveWork(runner.db, workKeys, heldBecause);
              save();
            });
          } finally { runner.close(); }
        } else {
          check(device === authority, 'move_pairing_changed');
          save();
        }
        return receipt();
      }
      if (action === 'get_chunk' || action === 'put_chunk') {
        check(['graph','board'].includes(input.kind), 'move_file_invalid');
        if (action === 'get_chunk') {
          check(row.step === 'sealed', 'move_phase_changed');
          return { ok: true, data: files.chunk(input.kind, input.position).toString('base64') };
        }
        check(row.step === 'frozen' && exactSeal(ticket.seal) && typeof input.data === 'string' &&
          input.data.length <= 24 * 1024, 'move_phase_changed');
        const data = Buffer.from(input.data, 'base64');
        check(data.toString('base64') === input.data, 'move_chunk_invalid');
        immediateTransaction(db, () => {
          files.declare(input.kind, ticket.seal[input.kind]);
          files.put(input.kind, input.position, data);
        });
        return { ok: true };
      }
      const seal = ticket.seal;
      if (action === 'stage') {
        check(exactSeal(seal), 'move_unsealed');
        if (row.step === 'staged') return receipt();
        check(['frozen','staging'].includes(row.step), 'move_phase_changed');
        const incoming = files.read('graph');
        const image = JSON.parse(files.read('board'));
        check(image.digest === seal.boardDigest && files.manifest('graph').digest === seal.graph.digest, 'move_file_changed');
        if (row.step === 'frozen') {
          const baseline = await graph('baseline');
          const oldBoard = board.exportForMove(scope);
          const lastSeal = db.prepare(`SELECT board_digest FROM move_participants WHERE space=? AND project=?
            AND generation=? AND step='forwarded'`).get(space, move.project, move.generation - 1);
          if (oldBoard.tables.some(table => table.count)) check(lastSeal?.board_digest === oldBoard.digest, 'board_target_not_empty');
          check(board.rehearseMove(scope, image, { baselineDigest: oldBoard.digest }) === seal.boardDigest, 'board_digest_changed');
          immediateTransaction(db, () => {
            rememberMoveTasks(db, move, incoming);
            if (!baseline.empty) files.save('baseline', baseline.text);
            db.prepare('UPDATE move_participants SET graph_digest=?,baseline_digest=?,board_digest=?,board_baseline=?' + keyWhere)
              .run(seal.graphDigest, baseline.digest ?? null, seal.boardDigest, oldBoard.digest, ...key);
            progress('staging');
          });
        }
        check((await graph('stage', incoming)).digest === seal.graphDigest, 'move_graph_changed');
        progress('staged');
        return receipt();
      }
      if (action === 'abort') {
        if (row.step === 'staging' || row.step === 'staged') {
          if (row.baseline_digest) check((await graph('restore', files.read('baseline'))).digest === row.baseline_digest, 'move_graph_changed');
          else check((await graph('discard')).ok, 'move_graph_changed');
        }
        const current = readProjectGate(directory, move.project);
        if (current.state === 'closed' || current.move_id === move.move_id) finishProjectGate(directory, move.project, { ...gate, commit: false });
        else check(row.step === 'requested' && current.state === 'open' && current.role === gate.role &&
          current.generation === move.generation, 'move_phase_changed');
        progress('aborted');
        return { ok: true, step: 'aborted' };
      }
      check(exactSeal(seal) && seal.graphDigest === row.graph_digest && seal.boardDigest === row.board_digest, 'move_seal_changed');
      if (action === 'activate') {
        check(['staged','promoted','installed','routed'].includes(row.step), 'move_phase_changed');
        if (row.step === 'staged') {
          check((await graph('promote')).digest === seal.graphDigest, 'move_graph_changed');
          progress('promoted');
        }
        if (row.step === 'promoted') {
          const image = JSON.parse(files.read('board'));
          const installed = board.installForMove(scope, image, { baselineDigest: row.board_baseline, installedDigest: seal.boardDigest });
          check(installed === seal.boardDigest && board.exportForMove(scope).digest === installed, 'board_digest_changed');
          progress('installed');
        }
      } else {
        check(['sealed','demoted','routed'].includes(row.step), 'move_phase_changed');
        if (row.step === 'sealed') {
          check((await graph('demote')).digest === seal.graphDigest, 'move_graph_changed');
          check(board.exportForMove(scope).digest === seal.boardDigest, 'board_digest_changed');
          progress('demoted');
        }
      }
      if (row.step !== 'routed') {
        await installRoute(move, target);
        progress('routed');
      }
      finishProjectGate(directory, move.project, { ...gate, role: target ? 'owner' : 'replica', commit: true });
      progress(target ? 'activated' : 'forwarded');
      return receipt();
    } finally { release(); }
  }
  return run;
}
