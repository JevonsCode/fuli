// Synthetic HTTP Provider harness; never connects to a public workspace.
import assert from 'node:assert/strict';
import { GraphitiProviderClient } from '../src/graphiti/provider-client.js';
import { submitPersonalDraft } from '../src/graphiti/public-submission.js';

const fixture = JSON.parse(process.env.FULI_SUBMISSION_FIXTURE);
const personal = new GraphitiProviderClient({ baseUrl: fixture.providerUrl, accessToken: fixture.accessToken });
let ticks = 0;
let remoteCalls = 0;
await assert.rejects(submitPersonalDraft({ personal, spaceId: fixture.spaceId, draftId: fixture.draftId,
  workspaceFor: () => ({ capabilities: { submitKnowledge: true }, client: { requestTimeoutMs: 30_000,
    createProposal() { remoteCalls++; throw new Error('Unexpected remote delivery'); } } })
}, { monotonicNow: () => ticks++ === 0 ? 0 : 120_001 }), { code: 'publication_submission_expired' });
const result = await personal.getPublicationDraft(fixture.spaceId, fixture.draftId);
assert.equal(result.status, 'pending');
assert.equal(remoteCalls, 0);
process.stdout.write(JSON.stringify({ pending: true, zeroRemoteCalls: true }));
