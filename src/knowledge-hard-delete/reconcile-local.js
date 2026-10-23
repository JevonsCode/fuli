import { readGraphRuntimeConfig } from '../graphiti/runtime-config.js';
import { GraphitiProviderClient } from '../graphiti/provider-client.js';
import { personalHumanReviewChannel } from '../graphiti/human-review-channel.js';
import { knowledgeHardDelete } from './console-port.js';
import { createKnowledgeRecoveryGate } from './recovery-gate.js';

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
      personalSpaceId: () => personal.spaceId
    });
    await reconcile.reconcile();
    // A reconciler result alone is not proof: verify the graph's current
    // watermark with the ordinary credential before reporting readiness.
    const gate = createGate({ dataDir: paths.dataDir,
      readWatermark: (request) => provider.readHardDeletionWatermark(request) });
    const state = await gate.refresh(personal.spaceId, { force: true });
    return state.state === 'open' ? { status: 'ready' }
      : { status: 'pending', reason: state.reason };
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
