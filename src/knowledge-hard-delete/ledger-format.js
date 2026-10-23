import { z } from 'zod';
import { contentHash } from '../../packages/roundtable/src/canonical-json.js';

const id = z.string().min(1);
const operation = z.object({
  id, spaceId: id, itemKind: z.enum(['entity', 'relationship', 'episode', 'session']), itemId: id,
  previewId: id.nullable().optional(), itemIds: z.array(id),
  sourceApplication: id.optional(), sessionId: id.optional(),
  state: z.enum(['pending', 'graph_deleted', 'complete', 'not_deleted']),
  deletionId: id.nullable().optional(), deletedAt: id.nullable().optional(),
  createdAt: id, updatedAt: id
}).strict();
const watermark = z.object({ count: z.number().int().nonnegative(), latestDeletedAt: id.nullable(), reconciledAt: id }).strict();
export const hardDeleteLedgerSchema = z.object({ version: z.literal(2),
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), operations: z.array(operation),
  watermarks: z.record(id, watermark)
}).strict();
export const HARD_DELETE_LEDGER_FINGERPRINT = contentHash(z.toJSONSchema(hardDeleteLedgerSchema));

export function ledgerDocument(operations, watermarks) {
  return hardDeleteLedgerSchema.parse({ version: 2, schemaFingerprint: HARD_DELETE_LEDGER_FINGERPRINT, operations, watermarks });
}
