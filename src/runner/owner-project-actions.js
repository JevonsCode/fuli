import { activeRunnerCaller } from '../app/agent-request-context.js';

const denied = code => ({ ok: false, code });
const keys = (object, allowed) => object && typeof object === 'object' && !Array.isArray(object)
  && Object.keys(object).every(key => allowed.includes(key));
const validRevision = value => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
const validWriter = writer => keys(writer, ['kind','agentId','agentName']) &&
  (writer.kind === 'person' ? Object.keys(writer).length === 1 : writer.kind === 'agent' &&
    [writer.agentId, writer.agentName].every(value => value === undefined || (typeof value === 'string' && value.length <= 160)));

// A private port reached only through the paired authority's project channel.
// All target identifiers come from the verified call, never from its input.
export function ownerProjectActions({ withApplication, board, receipts, authority }) {
  return async (job, { owns }) => {
    if (!owns() || activeRunnerCaller()) return denied('owner_request_refused');
    const personalSpaceId = job.spaceId;
    const projectId = job.scope.slice('project:'.length);
    const scope = { personalSpaceId, projectId };
    if (job.action === 'project_operation') {
      const id = job.input?.operationId;
      if (!keys(job.input, ['operationId']) || typeof id !== 'string' || !id || id.length > 128) return denied('owner_request_refused');
      return receipts.status(authority(), job, id);
    }
    if (job.action === 'board_read') {
      const value = await board({ spaceId: personalSpaceId, projectId }, job.input ?? {});
      return owns() ? { ok: true, value } : denied('owner_request_refused');
    }
    if (job.action === 'history_read') {
      const input = job.input ?? {};
      const limit = input.limit ?? 25;
      if (!keys(input, ['limit']) || !Number.isInteger(limit) || limit < 1 || limit > 100) return denied('owner_request_refused');
      const value = await withApplication(app => app.listPersonalProjectHistory({ ...scope, limit }));
      return owns() ? { ok: true, value } : denied('owner_request_refused');
    }
    if (job.action === 'project_read' && !job.input) {
      const value = await withApplication(app => app.personal.getPersonalProject(personalSpaceId, projectId));
      return owns() ? { ok: true, value } : denied('owner_request_refused');
    }
    if (job.action !== 'project_update' || !keys(job.input, ['profile','writer','expectedUpdatedAt']) ||
      !validRevision(job.input.expectedUpdatedAt) || !validWriter(job.input.writer) || !job.input.profile) return denied('owner_request_refused');
    const peer = authority();
    if (!peer) return denied('owner_request_refused');
    const claim = receipts.claim(peer, job);
    if (claim.result) return claim.result;
    try {
      const value = await withApplication(app => {
        if (!owns() || peer !== authority()) return null;
        return app.upsertPersonalProject({ ...scope, ...job.input });
      });
      const result = value ? { ok: true, operationId: job.requestId, updatedAt: value.updated_at, value } : denied('owner_request_refused');
      return receipts.finish(peer, job.requestId, claim.digest, result);
    } catch (error) {
      if (error.code === 'project_revision_changed') {
        const current = await withApplication(app => app.personal.getPersonalProject(personalSpaceId, projectId));
        return receipts.finish(peer, job.requestId, claim.digest, { ok: false, code: error.code, updatedAt: current.updated_at });
      }
      return denied('owner_result_unknown');
    }
  };
}
