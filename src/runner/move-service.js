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

export function hostMoveService({ dataDir, descriptor, hostStore, withPersonal, request, onError = () => {}, onIdle = () => {} }) {
  const { spaceId: space, authority } = descriptor;
  const db = new MoveStore(join(dataDir, PROJECT_MOVES_FILE));
  const registry = hostStore.ownership();
  const pairing = (peer, project) => {
    const grants = hostStore.grants(peer);
    return grants.allowed('project:' + project) ? grants.pairing() : null;
  };
  const participant = localParticipant({ dataDir, descriptor, moveStore: db, hostStore, withPersonal,
    decision: query => coordinator.ticket(query, true) });
  async function invoke(device, phase, move, payload) {
    if (device === authority) return participant.run(phase, move, payload);
    const grants = hostStore.grants(device);
    if (!grants.pairing()) throw moveError('move_waiting_for_participant');
    if (phase !== 'abort' && !grants.allowed('project:' + move.project)) throw moveError('move_project_grant_required');
    const result = await request({ spaceId: space, scope: 'project:' + move.project, generation: move.generation,
      owner: device, action: MOVE_ACTION, requestId: randomUUID(), input: { move: wireMove(move), phase, payload } });
    return result.ok ? result.result : result;
  }
  const coordinator = projectMoveCoordinator({ store: db, registry, dataDir, space, authority, pairing, paired: peer => Boolean(hostStore.grants(peer).pairing()), invoke,
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
        const pending = db.pending(space);
        if (!pending.length) onIdle();
        for (const row of pending) {
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
    async control(peer, input) {
      if (!input || typeof input.project !== 'string' || typeof input.moveId !== 'string' || !/^[a-zA-Z0-9._:-]{1,128}$/.test(input.moveId) ||
          input.spaceId !== space || !input.pairing || hostStore.grants(peer).pairing() !== input.pairing) return null;
      if (!pairing(peer, input.project)) throw moveError('move_project_grant_required', 403);
      let row = this.status(input.project, input.moveId);
      if (row && (row.pairing !== input.pairing || (row.source === authority ? row.target : row.source) !== peer)) return null;
      if (input.action === 'start') {
        const owner = row?.source ?? registry.owner(input.project)?.owner;
        if (owner !== peer && owner !== authority) return null;
        const target = owner === peer ? authority : peer;
        // Permission to read a single scope does not grant the power to take it.
        if (input.target !== target || (owner === authority && !hostStore.fullAccess(peer))) return null;
        row = this.start({ project: input.project, target, moveId: input.moveId, reason: input.reason,
          intentSource: input.relayed === true ? 'peer_agent' : 'peer_console' });
      } else if (input.action === 'cancel' && row) {
        if (row.intent_source !== 'peer_console' && row.intent_source !== 'peer_agent') return null;
        row = await this.cancel(input.project, input.moveId);
      } else if (input.action !== 'status' || !row) return null;
      if (pairing(peer, input.project) !== input.pairing) return null;
      return { moveId: row.move_id, project: row.project, source: row.source, target: row.target,
        step: row.step, reason: row.last_error, decision: registry.moveDecision(row.project, row.move_id)?.decision ?? null };
    },
    ticket(peer, move) {
      if (!validMove(move) || peer !== (move.source === authority ? move.target : move.source)) return null;
      try { return coordinator.ticket(move); }
      catch (error) {
        if (['move_pairing_changed','move_unknown','move_decision_unconfirmed'].includes(error.code)) return null;
        throw error;
      }
    },
    start(input) { const row = coordinator.start(input); schedule(0); return row; },
    recent() { return db.recent(space, registry); },
    status(project, moveId) { return db.request({ space, project, move_id: moveId }) ?? null; },
    async abandon(project, moveId) {
      const row = this.status(project, moveId);
      if (!row) throw moveError('move_unknown');
      try { return await coordinator.advance(row, false, true); } finally { schedule(0); }
    },
    async cancel(project, moveId) {
      const row = this.status(project, moveId);
      if (!row) throw moveError('move_unknown');
      try { return await coordinator.advance(row, true); } finally { schedule(0); }
    },
    async close() { closed = true; clearTimeout(timer); await running; participant.close(); db.close(); }
  };
}
