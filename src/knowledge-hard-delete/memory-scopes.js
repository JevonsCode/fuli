import { z } from 'zod';

const identity = z.string().min(1).max(256);
const revision = z.number().int().positive();
export const memoryScopesSchema = z.array(z.object({
  agentId: identity, personalProjectId: identity.nullable(),
  revisions: z.array(revision).min(1).max(10000).refine(values => new Set(values).size === values.length),
  currentRevision: revision
}).strict().refine(scope => scope.revisions.every(value => value <= scope.currentRevision))).max(10000)
  .refine(scopes => new Set(scopes.map(scope => JSON.stringify([scope.agentId, scope.personalProjectId]))).size === scopes.length);

// Human-review deletion receipts carry scope/revision metadata, never memory text.
// A lost local ledger rebuilds it from checkpoint scrubbed_by in the graph.
export function memoryScopesFromReceipt(deletion) {
  const rows = deletion.memory_scopes ?? [];
  const scopes = memoryScopesSchema.parse(rows.map(row => ({ agentId: row.agent_id,
    personalProjectId: row.personal_project_id, revisions: row.revisions, currentRevision: row.current_revision })));
  if (scopes.length && !['episode', 'session'].includes(deletion.item_kind)) {
    throw new TypeError('Only source deletion can clear Agent memory snapshots');
  }
  if (!scopes.length && (deletion.counts?.memory_checkpoints > 0 || deletion.counts?.memory_later_revisions > 0)) {
    throw new TypeError('Memory deletion receipt has no cleanup scopes');
  }
  return scopes;
}

export function forgetMemorySnapshots(snapshots, operation) {
  if (!operation.memoryScopes?.length) return [];
  try {
    if (!snapshots?.scrubMemory) throw new Error('snapshot_cleanup_unavailable');
    const results = operation.memoryScopes.map(scope => snapshots.scrubMemory({ personalSpaceId: operation.spaceId, ...scope }));
    if (results.some(result => result?.status !== 'current')) throw new Error('snapshot_cleanup_pending');
    return [{ store: 'agent-memory-snapshots', status: 'forgotten', changed: results.length }];
  } catch {
    return [{ store: 'agent-memory-snapshots', status: 'failed', reason: 'snapshot_cleanup_pending' }];
  }
}
