import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { acquireFileLock } from '../storage/file-lock.js';
import { MOVE_CHUNK } from './move-packages.js';
import { moveError, moveKey, sameMove, validMove } from './move-store.js';

const keyWhere = ' WHERE space=? AND project=? AND move_id=?';
const checked = answer => {
  if (!answer?.ok) throw moveError(answer?.code ?? 'move_participant_unavailable');
  return answer;
};
const publicSeal = row => row.seal ? JSON.parse(row.seal) : null;

// The host is the only coordinator. Only its ownership registry decides a
// transfer. Local progress may lag the decision across a crash; it cannot
// roll the decision back. Each call advances a bounded, replayable step.
export function projectMoveCoordinator({ store, registry, dataDir, space, authority, pairing, invoke, verifyCopy }) {
  const peerOf = move => move.source === authority ? move.target : move.source;
  function verify(move) {
    if (!validMove(move) || move.space !== space || ![move.target,move.source].includes(authority) ||
      pairing(peerOf(move), move.project) !== move.pairing) throw moveError('move_pairing_changed');
  }
  function start({ project, target, reason, moveId = randomUUID() }) {
    const prior = store.request({ space, project, move_id: moveId });
    if (prior) {
      verify(prior);
      if (prior.target !== target || prior.reason !== reason) throw moveError('move_changed');
      return prior;
    }
    const owner = registry.owner(project);
    if (owner?.state !== 'owned') throw moveError('ownership_unverified');
    const move = { space, project, move_id: moveId, source: owner.owner, target, generation: owner.generation };
    move.pairing = pairing(peerOf(move), project);
    verify(move);
    return store.begin(move, reason);
  }
  function ticket(move) {
    verify(move);
    const row = store.request(move);
    if (!sameMove(row, move)) throw moveError('move_unknown');
    const recorded = registry.moveDecision(move.project, move.move_id);
    if (!recorded || recorded.source !== move.source || recorded.target !== move.target ||
      recorded.generation !== move.generation) throw moveError('move_decision_unconfirmed');
    return { space, project: move.project, move_id: move.move_id, source: move.source, target: move.target,
      generation: move.generation, pairing: move.pairing, decision: recorded.decision, seal: publicSeal(row) };
  }
  async function advance(move, cancel = false) {
    verify(move);
    const name = createHash('sha256').update(JSON.stringify([space, move.project])).digest('hex');
    const release = acquireFileLock(join(dataDir, 'runner', 'move-locks', name + '-coordinator.lock'));
    try {
      let row = store.request(move);
      if (!sameMove(row, move)) throw moveError('move_unknown');
      if (['done','aborted'].includes(row.step)) return row;
      if (row.step === 'requested') {
        const existing = registry.moveDecision(move.project, move.move_id);
        if (!existing) checked(registry.decidePairedMove(authority, move, 'preparing'));
        row = store.advance(move, row.step, 'preparing');
      }
      const authoritative = ticket(move);
      if (cancel && authoritative.decision === 'committed') throw moveError('move_already_committed');
      if (cancel && authoritative.decision === 'preparing') {
        checked(registry.decidePairedMove(authority, move, 'aborted'));
        authoritative.decision = 'aborted';
      }
      const call = async (device, action, step, input) => {
        const answer = checked(await invoke(device, action, move, input));
        if (step && answer.step !== step) throw moveError('move_ack_unconfirmed');
        return answer;
      };
      const next = (step, seal) => store.advance(move, row.step, step, seal);
      if (authoritative.decision === 'aborted') {
        await call(move.target, 'abort', 'aborted');
        await call(move.source, 'abort', 'aborted');
        return next('aborted');
      }
      if (authoritative.decision === 'committed') {
        if (!['committed','activated','forwarded'].includes(row.step)) {
          if (row.step !== 'verified') throw moveError('move_decision_inconsistent');
          return next('committed');
        }
        if (row.step === 'committed') {
          await call(move.target, 'activate', 'activated');
          return next('activated');
        }
        if (row.step === 'activated') {
          await call(move.source, 'forward', 'forwarded');
          return next('forwarded');
        }
        if (!(await verifyCopy(move, authoritative.seal))) throw moveError('move_copy_unverified');
        return next('done');
      }
      if (row.step === 'preparing') {
        await call(move.target, 'freeze', 'frozen');
        return next('target_frozen');
      }
      if (row.step === 'target_frozen') {
        await call(move.source, 'freeze', 'frozen');
        return next('frozen');
      }
      if (row.step === 'frozen') {
        const receipt = await call(move.source, 'seal', 'sealed');
        const { graphDigest, boardDigest, graph, board } = receipt;
        return next('graph', { graphDigest, boardDigest, graph, board });
      }
      const seal = authoritative.seal;
      if (row.step === 'graph' || row.step === 'board') {
        const kind = row.step;
        const info = seal?.[kind];
        if (!Number.isSafeInteger(info?.bytes) || info.bytes < 1 || info.bytes > 64 * 1024 * 1024) throw moveError('move_file_invalid');
        let position = row.position;
        for (let count = 0; count < 32 && position < info.bytes; count++) {
          const part = await call(move.source, 'get_chunk', null, { kind, position });
          await call(move.target, 'put_chunk', null, { kind, position, data: part.data });
          position += Math.min(MOVE_CHUNK, info.bytes - position);
        }
        const step = position === info.bytes ? (kind === 'graph' ? 'board' : 'received') : kind;
        store.db.prepare('UPDATE move_requests SET step=?,position=?,last_error=NULL,updated_at=?' + keyWhere + ' AND step=? AND position=?')
          .run(step, step === kind ? position : 0, new Date().toISOString(), ...moveKey(move), kind, row.position);
        return store.request(move);
      }
      if (row.step === 'received') {
        const ack = await call(move.target, 'stage', 'staged');
        if (ack.graphDigest !== seal.graphDigest || ack.boardDigest !== seal.boardDigest ||
          ack.graph?.digest !== seal.graph.digest || ack.board?.digest !== seal.board.digest) throw moveError('move_seal_changed');
        return next('verified');
      }
      if (row.step !== 'verified') throw moveError('move_decision_inconsistent');
      checked(registry.decidePairedMove(authority, move, 'committed'));
      return next('committed');
    } catch (error) {
      const code = /^[a-z_]{1,80}$/.test(error?.code) ? error.code : 'move_unavailable';
      store.db.prepare('UPDATE move_requests SET last_error=?,updated_at=?' + keyWhere)
        .run(code, new Date().toISOString(), ...moveKey(move));
      throw error;
    } finally { release(); }
  }
  return { start, ticket, advance };
}
