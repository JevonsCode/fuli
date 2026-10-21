import { join } from 'node:path';

import { readJsonFile } from '../storage/json-file.js';
import { jsonFormat, updateVersionedJsonFileAtomic } from '../storage/json-format.js';

// The idempotency receipts of confirmed applies (rec#17 D-09 part 2): for a
// plan digest, the parts each store was asked to apply. Kept apart from the
// operations log, whose display events (one per pruned backup, for one) must
// never push a receipt out: confirming the same digest again after a lost
// answer finds its receipt here and re-runs those parts, which each store
// answers as already applied. Bounded by the number of applies, not events.

const RECEIPTS_VERSION = 1;
const KEPT_RECEIPTS = 100;
export const APPLY_RECEIPTS_FORMAT = jsonFormat({ store: 'format-apply-receipts', versions: [RECEIPTS_VERSION] });

function receiptsPath(dataDir) {
  return join(dataDir, 'format-apply-receipts.json');
}

export function recordApplyReceipt(dataDir, receipt) {
  updateVersionedJsonFileAtomic(receiptsPath(dataDir), APPLY_RECEIPTS_FORMAT, (current) => ({
    version: RECEIPTS_VERSION,
    receipts: [...(current?.receipts ?? []).filter((entry) => entry.planDigest !== receipt.planDigest), receipt]
      .slice(-KEPT_RECEIPTS)
  }));
}

export function findApplyReceipt(dataDir, planDigest) {
  try {
    return readJsonFile(receiptsPath(dataDir), { receipts: [] }).receipts
      ?.findLast((entry) => entry.planDigest === planDigest) ?? null;
  } catch {
    return null;
  }
}
