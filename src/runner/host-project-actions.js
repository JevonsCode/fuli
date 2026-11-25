import { randomUUID } from 'node:crypto';
import { activeRunnerCaller } from '../app/agent-request-context.js';
import { projectCopyStatus } from './project-copy-sync.js';

// Only called from a local UI or local Agent entry whose writer is already
// established. Peer requests may not relay through this host to a third device.
export function hostProjectActions({ spaceId, device, dataDir, registry, request, changed, now = Date.now }) {
  const owned = project => registry().owner(project);
  const remote = project => registry().remoteOwner(device, project);
  function source(project) {
    const row = remote(project);
    if (!row) {
      const claim = owned(project);
      if (!claim || claim.state === 'owned' && claim.owner === device) return null;
      return { owner: claim.owner, project, generation: claim.generation, copied: false, readable: false, localClaim: claim.owner === device,
        status: claim.state === 'conflict' ? 'project_conflict' : 'ownership_unverified' };
    }
    const snapshot = projectCopyStatus(dataDir, spaceId, row).read();
    return { owner: row.owner, generation: row.generation, project,
      copied: Boolean(snapshot?.syncedAt), readable: Boolean(snapshot?.syncedAt) && snapshot?.outcome !== 'importing', syncedAt: snapshot?.syncedAt ?? null, checkedAt: snapshot?.checkedAt ?? null,
      attemptedAt: snapshot?.attemptedAt ?? null, status: snapshot?.outcome ?? 'copy_pending' };
  }
  async function call({ project, action, input, relayed = false, operationId = randomUUID() }) {
    const row = owned(project);
    if (!row || row.owner === device && row.state === 'owned') return null;
    const no = (code, dispatched = false) => ({ ok: false, code, dispatched, operationId });
    if (relayed || activeRunnerCaller() || !['project_update','project_operation','project_read','board_read','history_read'].includes(action)) return no('owner_request_refused');
    const owner = remote(project);
    if (!owner) return no(row.state === 'conflict' ? 'project_conflict' : 'ownership_unverified');
    if (action === 'project_update' && !input?.expectedUpdatedAt) return no('project_revision_required');
    const answer = await request({ action, spaceId, scope: 'project:' + project, owner: owner.owner,
      generation: owner.generation, requestId: operationId, ...(input ? { input } : {}) });
    if (!answer.ok) return no(answer.code, answer.dispatched === true);
    const current = remote(project);
    if (current?.owner !== owner.owner || current.generation !== owner.generation || current.pairing !== owner.pairing) {
      return no('owner_result_unknown', true);
    }
    if (action === 'project_update' && answer.result?.ok) changed(project);
    return { ...answer.result, operationId, dispatched: true, source: { owner: owner.owner, generation: owner.generation,
      observedAt: new Date(now()).toISOString() } };
  }
  return { source, call, reportedProjects: () => registry().reportedProjects() };
}
