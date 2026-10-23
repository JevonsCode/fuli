import { ApplicationError } from '../app/application-error.js';
import { assertPublicKnowledgeEligible } from './knowledge-provider-mapping.js';
import { ProviderRequestError } from './provider-client.js';

export const SUBMISSION_TTL_MS = 120_000;
const REMOTE_TIMEOUT_MS = 30_000;

// The Provider reserves the draft under the same space lock used by source
// deletion. Only the returned reservation authorizes sending its body away.
export async function submitPersonalDraft({ personal, workspaceFor, spaceId, draftId },
  { monotonicNow = () => performance.now() } = {}) {
  const pending = await personal.getPublicationDraft(spaceId, draftId);
  publicationTarget(pending, workspaceFor, 'pending');
  // Start before admission: time waiting for the response consumes our lease
  // budget too. A remote wall clock ahead must not authorize an expired send.
  const started = monotonicNow();
  const controlTimeoutMs = Math.min(personal.requestTimeoutMs ?? REMOTE_TIMEOUT_MS, REMOTE_TIMEOUT_MS);
  const draft = await personal.decidePublicationDraft(spaceId, draftId, { decision: 'begin_submit_public' }, { timeoutMs: controlTimeoutMs });
  const decide = input => personal.decidePublicationDraft(spaceId, draftId,
    { ...input, submission_id: draft.submission_id }, { signal: null, timeoutMs: controlTimeoutMs });
  // Failure to record uncertainty cannot turn it into a definite refusal. The
  // Provider's TTL and later metadata reconciliation remain the recovery path.
  const markUnknown = () => decide({ decision: 'mark_submission_unknown' }).catch(() => {});
  let remoteCallStarted = false;
  let proposal;
  try {
    const { client } = publicationTarget(draft, workspaceFor, 'submitting');
    if (!draft.submission_id) {
      throw new ApplicationError('publication_draft_not_pending', 'Publication draft has no reservation', { status: 409 });
    }
    const timeoutMs = Math.min(client.requestTimeoutMs ?? REMOTE_TIMEOUT_MS, REMOTE_TIMEOUT_MS);
    if (!(monotonicNow() - started + timeoutMs < SUBMISSION_TTL_MS)
        || !(Date.parse(draft.submission_started_at) + SUBMISSION_TTL_MS > Date.now() + timeoutMs)) {
      throw new ApplicationError('publication_submission_expired', 'Submission reservation expired; retry the draft', { status: 409 });
    }
    // Set synchronously before entering the transport, including a synchronous
    // throw. Only a failure before this line proves no delivery was attempted.
    remoteCallStarted = true;
    proposal = await client.createProposal(draft.target_project_id, { episode: draft.episode }, { timeoutMs });
  } catch (error) {
    if (!remoteCallStarted) {
      await decide({ decision: 'release_submit_public', delivery_not_started: true,
        last_submission_error: { code: 'publication_ineligible' } });
    } else if (error instanceof ProviderRequestError && error.status >= 400 && error.status < 500 && error.status !== 408) {
      await decide({ decision: 'release_submit_public', last_submission_error: { code: error.code } });
    } else await markUnknown();
    throw error;
  }
  try {
    if (typeof proposal?.id !== 'string' || !proposal.id) {
      throw new ProviderRequestError('Public provider returned no proposal identity', { code: 'provider_invalid_response' });
    }
    return await decide({ decision: 'submit_public', shared_proposal_id: proposal.id });
  } catch (error) {
    // The public write already happened. Even a definite local refusal must
    // never release it back to pending as if no remote proposal existed.
    await markUnknown();
    throw error;
  }
}

// Validate before reserving, then recheck the Provider's returned body/target:
// the draft may change while admission waits for its space lock.
function publicationTarget(draft, workspaceFor, status) {
  if (draft.status !== status || !draft.episode || draft.payload_scrubbed_by) {
    throw new ApplicationError('publication_draft_not_pending', 'Publication draft is not pending', { status: 409 });
  }
  if (draft.episode.sensitivity !== 'normal') {
    throw new TypeError('Private or restricted knowledge cannot be submitted publicly');
  }
  assertPublicKnowledgeEligible(draft.episode);
  const workspace = workspaceFor(draft.provider_url);
  if (workspace.capabilities.submitKnowledge === false) {
    throw new TypeError(`Operation is not supported by ${workspace.protocol}`);
  }
  return workspace;
}
