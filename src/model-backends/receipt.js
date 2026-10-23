// What a role keeps or shows of a model receipt: who was asked and what came
// back, never endpoint details or timing. Shared by every built-in Agent role.
// modelDigest: the served build when its backend proved it, else null; a
// receipt stored before digests were reported has none, also null.
export function compactReceipt(receipt) {
  const { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel, attempts, usage } = receipt;
  return { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel,
    modelDigest: receipt.modelDigest ?? null, attempts, usage };
}
