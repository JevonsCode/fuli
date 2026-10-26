import { personalHumanReviewChannel } from '../src/graphiti/human-review-channel.js';
import { knowledgeOwnerReads } from '../src/knowledge-owner-reads/console-port.js';

export const OWNER_PROOF_TOKEN = 'synthetic-human-review-token';

// The console's real owner-read port over the real human-review channel,
// against a synthetic Provider that, like the graph provider, accepts only its
// own human-review token. envToken: what the data directory's provider env
// holds (null: none). sent: each request with the proof it carried.
export function ownerProofPort(envToken = OWNER_PROOF_TOKEN) {
  const sent = [];
  const files = { 'graph-runtime.json': JSON.stringify({ personal: { providerUrl: 'http://127.0.0.1:8787', accessToken: 'agent-token' } }),
    'graph-provider.env': envToken ? `FULI_PERSONAL_HUMAN_REVIEW_TOKEN=${envToken}\n` : '' };
  const fetchImpl = async (url, { headers }) => {
    const proof = headers['x-fuli-human-review-token'];
    sent.push({ url, proof });
    const status = proof === OWNER_PROOF_TOKEN ? 200 : 403;
    return new Response(JSON.stringify(status === 200 ? { nodes: [], edges: [] } : { detail: 'independent human review proof required' }), { status });
  };
  const send = personalHumanReviewChannel('synthetic-data-dir', { fetchImpl, readText: path => files[path.split(/[\\/]/).pop()] });
  return { port: knowledgeOwnerReads('synthetic-data-dir', { send }), sent };
}
