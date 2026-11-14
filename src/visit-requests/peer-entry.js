// The visiting assistant's two request actions (visit_shared_lead request and
// request_status) as they arrive from a paired device, answered through the
// visitor-access port. The requester key is the asking device's verified
// fingerprint; the share decides the project, its lead and its folder, never
// the assertion. A new request needs the share's Agent to be the project's
// lead now (confirmLead resolves null, or a refusal code); a status read
// answers only the device that made the request. Answers what crosses back:
// { ok: true, requestId, state } or the requester's status view, or
// { ok: false, code } with a plain code.
export const VISIT_REQUEST_ACTIONS = new Set(['request', 'request_status']);

export async function answerVisitRequest({ visitorAccess, requester, projectId, agentId, workingDirectory, query, confirmLead }) {
  if (!visitorAccess) return { ok: false, code: 'requests_unavailable' };
  if (query.action === 'request_status') return visitorAccess.requestStatus({ requester, requestId: query.requestId });
  const refusal = await confirmLead();
  if (refusal) return { ok: false, code: refusal };
  return visitorAccess.submitRequest({ requester, projectId, agentId, projectFolder: workingDirectory, request: query.request });
}
