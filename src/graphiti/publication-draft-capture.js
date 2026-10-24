import { receiptConsoleUrl } from '../agents/identity-receipt.js';
import { ProviderRequestError } from './provider-client.js';

// A capture for a team project waits as a local pre-review draft until the
// person submits it from the console's publish queue. The Provider answers a
// create that meets an existing draft this caller may not read exactly as a
// missing draft (0.20.1): a team-only draft is the person's alone, and a
// self-reported source is no proof that it is the same create. That happens
// only when a draft under this key already exists, typically a retry after a
// lost reply, so the capture is reported unconfirmed: neither saved nor lost.
const UNCONFIRMED = 'The draft for this capture could not be confirmed: one under the same key already exists '
  + 'and only the person can read it. Ask them to check the publish queue in the FULI console.';

export async function queuePublicationDraft(application, { input, workspace, episode }) {
  const queued = { route: 'personal_review', projectId: input.spaceId, providerUrl: workspace.providerUrl };
  try {
    const draft = await application.personal.createPublicationDraft({
      personal_space_id: application.config.personal.spaceId,
      target_project_id: input.spaceId,
      provider_url: workspace.providerUrl,
      episode
    });
    return { ...queued, status: draft.status, draftId: draft.id };
  } catch (error) {
    if (!(error instanceof ProviderRequestError && error.status === 404)) throw error;
    return { ...queued, status: 'unconfirmed', message: UNCONFIRMED,
      reviewUrl: `${receiptConsoleUrl(application)}/public-projects` };
  }
}
