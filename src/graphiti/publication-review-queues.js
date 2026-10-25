import { submitPersonalDraft } from './public-submission.js';
import { reconcilePublicSubmissions } from './public-submission-reconciliation.js';
import { parsePersonalDraftDecision } from './publication-draft-input.js';
import { configuredWorkspace } from './workspace-provider-client.js';

// An Agent's list leaves out a draft of an FLA's work (made before the Provider refused them);
// only the console passes ownerReads (src/knowledge-owner-reads) for the person's full list.
export async function listPersonalReviewQueue(application, input = {}, ownerReads = null) {
  const personalSpaceId = input.personalSpaceId ?? application.config.personal.spaceId;
  if (personalSpaceId !== application.config.personal.spaceId) {
    throw new TypeError('Personal review must use the active personal space');
  }
  await application.reconcilePersonalSubmissions({}, ownerReads);
  const status = input.status ?? 'pending';
  return { personalSpaceId, drafts: ownerReads ? await ownerReads.publicationDrafts({ personalSpaceId, status })
    : await application.personal.listPublicationDrafts(personalSpaceId, status) };
}

// ownerReads: the console's port, which alone lists and settles a draft of an FLA's work.
export function reconcilePersonalSubmissions(application, options = {}, ownerReads = null) {
  return reconcilePublicSubmissions({ personal: ownerReads?.submissions ?? application.personal,
    workspaceFor: url => configuredWorkspace(application.workspaces, url), spaceId: application.config.personal.spaceId }, options);
}

// ownerReads: the console's port; an Agent decides only a draft of positively plain work.
export async function reviewPersonalDraft(application, input, ownerReads = null) {
  input = parsePersonalDraftDecision(input);
  const personalSpaceId = application.config.personal.spaceId;
  const personal = ownerReads?.submissions ?? application.personal;
  if (input.decision !== 'submit_public') {
    return personal.decidePublicationDraft(personalSpaceId, input.draftId, { decision: input.decision,
      shared_proposal_id: null });
  }
  return submitPersonalDraft({ personal, workspaceFor: url => configuredWorkspace(application.workspaces, url),
    spaceId: personalSpaceId, draftId: input.draftId });
}

export async function listReviewQueue(application, { projectId, providerUrl, status = 'pending' }) {
  const workspace = configuredWorkspace(application.workspaces, providerUrl);
  return {
    projectId,
    providerUrl: workspace.providerUrl,
    proposals: await workspace.client.listProposals(projectId, status)
  };
}

export async function reviewProposal(application, { projectId, providerUrl, proposalId, decision, note = null }) {
  const workspace = configuredWorkspace(application.workspaces, providerUrl);
  return workspace.client.decideProposal(projectId, proposalId, { decision, note });
}
