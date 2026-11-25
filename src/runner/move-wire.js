import { digestValue, validMove } from './move-store.js';

export const MOVE_ACTION = 'project_move_phase';
export const moveDecisions = Object.freeze({
  inspect: 'preparing', freeze: 'preparing', seal: 'preparing', stage: 'preparing', get_chunk: 'preparing',
  put_chunk: 'preparing', activate: 'committed', forward: 'committed', verify_copy: 'committed', abort: 'aborted'
});
export function wireMove({ space, project, move_id, source, target, generation, pairing }) {
  return { space, project, move_id, source, target, generation, pairing };
}
export function isParticipantJob(job, authority) {
  const { phase, move } = job?.input ?? {};
  if (job?.action !== MOVE_ACTION || !Object.hasOwn(moveDecisions, phase) || !validMove(move) ||
    !digestValue(authority) || ![move.source,move.target].includes(authority) ||
    job.owner !== (move.source === authority ? move.target : move.source) || job.scope !== 'project:' + move.project ||
    job.spaceId !== move.space || job.generation !== move.generation || job.pairing !== move.pairing) return false;
  if (['seal','get_chunk','forward'].includes(phase)) return job.owner === move.source;
  if (['stage','put_chunk','activate'].includes(phase)) return job.owner === move.target;
  return true;
}
