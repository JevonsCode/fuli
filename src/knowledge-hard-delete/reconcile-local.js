import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { GraphitiProviderClient } from '../graphiti/provider-client.js';
import { personalHumanReviewChannel } from '../graphiti/human-review-channel.js';
import { knowledgeHardDelete } from './console-port.js';
import { createKnowledgeRecoveryGate } from './recovery-gate.js';
import { reconcileAndVerify } from './recovery-check.js';
import { createAgentDirectorySnapshots } from '../agents/directory-snapshots.js';

// Setup and the maintenance CLI resume the same already-confirmed deletions
// as the console. This module is never reached from an Agent or MCP entry.
export async function reconcileLocalKnowledge(paths, {
  fetchImpl = globalThis.fetch,
  readConfig = readGraphRuntimeConfig,
  createReconciler = knowledgeHardDelete,
  createGate = createKnowledgeRecoveryGate
} = {}) {
  try {
    const { personal } = readConfig(paths.graphRuntimeConfigPath);
    const provider = new GraphitiProviderClient({ baseUrl: personal.providerUrl,
      accessToken: personal.accessToken, fetchImpl });
    const reconcile = createReconciler(paths.dataDir, {
      send: personalHumanReviewChannel(paths.dataDir, { fetchImpl }),
      agentSnapshots: createAgentDirectorySnapshots({ root: paths.agentDirectoryRoot, providerIdentity: personal.providerUrl }),
      personalSpaceId: () => personal.spaceId
    });
    const gate = createGate({ dataDir: paths.dataDir,
      readWatermark: (request) => provider.readHardDeletionWatermark(request) });
    return await reconcileAndVerify({ reconcile: () => reconcile.reconcile(), gate, spaceId: personal.spaceId });
  } catch {
    // Provider/config errors can contain secrets or item details. Keep the
    // maintenance result content-free, and never turn a failed run into ready.
    return { status: 'pending', reason: 'reconciliation_unavailable' };
  }
}

export function knowledgeReconciliationMessage(result) {
  return result.status === 'ready'
    ? 'Knowledge recovery checked; local stores are ready.'
    : 'Knowledge recovery is pending. Ensure the personal Provider is running, then run '
      + 'fuli migrate reconcile-knowledge for this data directory.';
}
