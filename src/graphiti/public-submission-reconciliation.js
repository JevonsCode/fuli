// Reconcile by submission metadata only: never reload a draft body and never
// resend a proposal. One deadline bounds the complete best-effort pass.
import { SUBMISSION_TTL_MS } from './public-submission.js';

export async function reconcilePublicSubmissions({ personal, workspaceFor, spaceId }, { timeoutMs = 5_000 } = {}) {
  const controller = new AbortController();
  const deadline = Date.now() + Math.min(timeoutMs, 5_000);
  const options = () => ({ signal: controller.signal, timeoutMs: Math.max(1, deadline - Date.now()) });
  let expire;
  const expired = new Promise(resolve => { expire = setTimeout(() => { controller.abort(); resolve(); }, Math.max(1, deadline - Date.now())); });
  const reconcile = async () => {
    const drafts = await personal.listPublicationDrafts(spaceId, 'all', { ...options(), metadataOnly: true });
    for (const draft of drafts) {
      if (controller.signal.aborted) return;
      const elapsed = Date.now() - Date.parse(draft.submission_started_at);
      if (!(draft.status === 'submission_unknown' || (draft.status === 'submitting' && elapsed >= SUBMISSION_TTL_MS)
          || (draft.status === 'source_deleted' && draft.submission_outcome === 'unknown'))
          || !draft.submission_id || !draft.source_identity?.idempotency_key) continue;
      try {
        const client = workspaceFor(draft.provider_url).client;
        const proposal = await client.lookupProposal(draft.target_project_id, draft.source_identity.idempotency_key, options());
        if (controller.signal.aborted) return;
        if (proposal?.id || (proposal === null && draft.status !== 'source_deleted')) {
          await personal.decidePublicationDraft(spaceId, draft.id, {
            decision: 'reconcile_submit_public', submission_id: draft.submission_id,
            lookup_result: proposal === null ? null : { id: proposal.id, status: proposal.status }
          }, options());
        }
      } catch {
        // An unreachable provider proves nothing. Keep the reservation/unknown
        // state and let the next queue read or explicit recheck try metadata.
      }
    }
  };
  try { await Promise.race([reconcile().catch(() => {}), expired]); }
  finally { clearTimeout(expire); controller.abort(); }
}
