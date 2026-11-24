// Withdrawing a request FULI put in the person's 待决策 that no longer stands:
// its wording changed, or the FLA already did what it asked about. Only an
// open request is cancelled, at the revision it was read at; one the person
// answered is theirs and is never touched. Never throws: a request that stays
// open is asked about again on a later tick, never lost.
export async function cancelIfOpen(app, { personalSpaceId, requestId, reason }) {
  if (!requestId || !app.getAgentAttention || !app.cancelAgentAttention) return 'skipped';
  try {
    const request = await app.getAgentAttention({ personalSpaceId, requestId });
    if (request?.status !== 'open') return 'not_open';
    await app.cancelAgentAttention({ personalSpaceId, personalProjectId: request.personalProjectId, requestId,
      expectedRevision: request.revision ?? 0, response: reason });
    return 'cancelled';
  } catch {
    return 'not_cancelled';
  }
}
