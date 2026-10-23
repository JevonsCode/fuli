// What a role keeps or shows of a model receipt: who was asked and what came
// back, never endpoint details or timing. Shared by every built-in Agent role.
export function compactReceipt(receipt) {
  const { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel, attempts, usage } = receipt;
  return { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel, attempts, usage };
}
