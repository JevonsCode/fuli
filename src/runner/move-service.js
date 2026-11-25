import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { JefaBoardStore } from '../employees/builtin/jefa/board-store.js';
import { recordOwnedProject } from './owned-project-routes.js';
import { projectMoveCoordinator } from './project-move.js';
import { moveParticipant } from './move-participant.js';
import { MoveStore, PROJECT_MOVES_FILE, moveError, validMove } from './move-store.js';
import { MOVE_ACTION, wireMove } from './move-wire.js';
import { hostOwner, LOCAL_OWNER, ROUTES_FILE, RoutesStore } from './routes-store.js';

function localParticipant({ dataDir, descriptor, moveStore, hostStore, withPersonal, decision }) {
  const { spaceId: space, device, authority } = descriptor;
  const board = new JefaBoardStore(join(dataDir, 'employees', 'data', 'jefa', 'board.sqlite'));
  const run = moveParticipant({ store: moveStore, dataDir, space, device, authority, decision, board,
    inspect: input => withPersonal(personal => personal.projectHandoverProof(input)),
    handover: input => withPersonal(personal => personal.projectHandover(input)),
    installRoute: async (move, local) => {
      const registry = hostStore.ownership();
      if (device !== authority) {
        const result = local ? registry.rememberPermit(authority, device, { ok: true, state: 'owned', owner: device,
          project: move.project, spaceId: space, generation: move.generation + 1, operation: move.move_id }) :
          registry.retireMovePermit(authority, move);
        if (!result.ok) throw moveError('move_permit_changed');
      }
      const routes = new RoutesStore(join(dataDir, ROUTES_FILE));
      try { routes.installMove('project:' + move.project, local ? LOCAL_OWNER : hostOwner(move.target)); }
      finally { routes.close(); }
      if (device !== authority) recordOwnedProject(dataDir, 'project:' + move.project);
    } });
  return { run, close: () => board.close() };
}

export function followerMoveParticipant({ dataDir, descriptor, hostStore, withPersonal, decision }) {
  return async (phase, move, input) => {
    const local = descriptor();
    if (!local || local.spaceId !== move?.space || local.authority === local.device) throw moveError('move_pairing_changed');
    const db = new MoveStore(join(dataDir, PROJECT_MOVES_FILE));
    const participant = localParticipant({ dataDir, descriptor: local, moveStore: db, hostStore, withPersonal,
      decision: async query => {
        const value = await decision(wireMove(query));
        const current = descriptor();
        if (!current || current.authority !== local.authority || current.device !== local.device) throw moveError('move_pairing_changed');
        return value;
      } });
    try { return await participant.run(phase, move, input); }
    finally { participant.close(); db.close(); }
  };
}

export function hostMoveService({ dataDir, descriptor, hostStore, withPersonal, request, onError = () => {} }) {
  const { spaceId: space, authority } = descriptor;
  const db = new MoveStore(join(dataDir, PROJECT_MOVES_FILE));
  const registry = hostStore.ownership();
  const pairing = (peer, project) => {
    const grants = hostStore.grants(peer);
    return grants.allowed('project:' + project) ? grants.pairing() : null;
  };
  const participant = localParticipant({ dataDir, descriptor, moveStore: db, hostStore, withPersonal,
    decision: query => coordinator.ticket(query) });
  async function invoke(device, phase, move, payload) {
    if (device === authority) return participant.run(phase, move, payload);
    const result = await request({ spaceId: space, scope: 'project:' + move.project, generation: move.generation,
      owner: device, action: MOVE_ACTION, requestId: randomUUID(), input: { move: wireMove(move), phase, payload } });
    return result.ok ? result.result : result;
  }
  const coordinator = projectMoveCoordinator({ store: db, registry, dataDir, space, authority, pairing, invoke,
    verifyCopy: async move => {
      const copy = await invoke(move.source, 'verify_copy', move);
      const owner = await invoke(move.target, 'verify_copy', move);
      return copy?.ok && owner?.ok && copy.owner === move.target && owner.owner === null && copy.digest === owner.digest;
    } });
  let running, timer, closed = false;
  function schedule(delay) {
    if (closed || running) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      let nextDelay = 30_000;
      running = (async () => {
        for (const row of db.pending(space)) {
          if (closed) return;
          try { await coordinator.advance(row); nextDelay = 200; }
          catch (error) { if (row.last_error !== error.code) onError(error); }
        }
      })().catch(onError).finally(() => { running = null; schedule(nextDelay); });
    }, delay);
    timer.unref?.();
  }
  schedule(100);
  return {
    ticket(peer, move) {
      if (!validMove(move) || peer !== (move.source === authority ? move.target : move.source)) return null;
      return coordinator.ticket(move);
    },
    start(input) { const row = coordinator.start(input); schedule(0); return row; },
    status(project, moveId) { return db.request({ space, project, move_id: moveId }) ?? null; },
    async cancel(project, moveId) {
      const row = this.status(project, moveId);
      if (!row) throw moveError('move_unknown');
      try { return await coordinator.advance(row, true); } finally { schedule(0); }
    },
    async close() { closed = true; clearTimeout(timer); await running; participant.close(); db.close(); }
  };
}
