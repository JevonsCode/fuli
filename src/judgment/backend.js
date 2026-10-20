import { runJudgment } from './model.js';
import { parseModelJson } from '../text/model-json.js';

// Who answers a Tonborg judgment (rec#8, D-04 §2 and §6). Tonborg's model,
// when configured, through the shared port; otherwise a work package for the
// current session. The old CLI client runs only when the saved policy opts in
// with backend legacy_cli: a stored policy without that field, as every
// policy written before the model port, never starts a CLI.

export const TONBORG_OPERATIONS = Object.freeze({
  review: 'knowledge_review', routing: 'executor_routing', acceptance: 'task_acceptance'
});

export function createJudgmentBackend({ bridge = null, legacy = runJudgment } = {}) {
  return async function judge(call) {
    if (call.policy.backend === 'legacy_cli') {
      return { ...await legacy({ client: call.client, quality: call.quality, prompt: call.prompt }),
        status: 'answered', mode: 'legacy_cli', independent: true };
    }
    if (!bridge) throw Object.assign(new Error('No judgment backend is available'), { code: 'judgment_backend_unavailable' });
    // execution: set on a rerun that applies a session answer (role_work).
    const outcome = await bridge.decide(judgmentRequest(call), { resume: call.resume, execution: call.execution ?? null });
    if (outcome.status !== 'answered') return outcome;
    const { envelope, modelReceipt } = outcome;
    return outcome.mode === 'model_api'
      ? { status: 'answered', mode: 'model_api', independent: true, value: envelope.payload, client: null,
        model: modelReceipt.actualModel ?? modelReceipt.requestedModel, sessionId: null, modelReceipt }
      : { status: 'answered', mode: 'current_session', independent: false, value: envelope.payload,
        client: outcome.session.sourceApplication, model: null, sessionId: outcome.session.sessionRef,
        modelReceipt, workPackageId: outcome.workPackageId };
  };
}

// One shape for every backend, including an injected judge that returns the
// old { body, client } answer. A stop (refusal, privacy, permission or budget)
// throws with its reason; it never falls back to another backend.
export function judgmentAnswer(response) {
  if (response.status === 'pending') return { pending: response.workPackage, modelReceipt: response.modelReceipt };
  if (response.status && response.status !== 'answered') {
    throw Object.assign(new Error(`Tonborg's model did not answer (${response.status}: ${response.modelReceipt.reason})`),
      { code: response.modelReceipt.reason, modelReceipt: response.modelReceipt });
  }
  return { value: response.value ?? parseModelJson(response.body), client: response.client ?? null,
    model: response.model ?? null, sessionId: response.sessionId ?? null,
    judgedBy: response.mode ? { mode: response.mode, independent: response.independent } : null,
    modelReceipt: response.modelReceipt ?? null };
}

// What a judgment record keeps about who judged; null when nobody did. C13:
// a current-session answer is recorded as such, never as independent.
export function judgmentProvenance(answer) {
  if (!answer) return { client: null, model: null, sessionId: null };
  return { client: answer.client, model: answer.model, sessionId: answer.sessionId,
    ...(answer.judgedBy ? { judgedBy: answer.judgedBy } : {}),
    ...(answer.modelReceipt ? { modelReceipt: compactReceipt(answer.modelReceipt) } : {}) };
}

// A pending record says only that work was handed off; nothing ran.
export function pendingRecord(answer) {
  return { outcome: 'pending', summary: 'Tonborg handed this judgment to the current session. Nothing was judged or executed yet.',
    evidence: [], workPackage: answer.pending, ...(answer.modelReceipt ? { modelReceipt: compactReceipt(answer.modelReceipt) } : {}) };
}

export function failureProvenance(error) {
  return error.modelReceipt ? { modelReceipt: compactReceipt(error.modelReceipt) } : {};
}

function compactReceipt(receipt) {
  const { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel, attempts, usage } = receipt;
  return { backend, status, reason, failureClass, fallbackReason, requestedModel, actualModel, attempts, usage };
}

// Each top-level part of the judgment data is one evidence item, so the
// port's egress check sees every part with its project.
function judgmentRequest(call) {
  const personalProjectId = call.scope.personalProjectId ?? null;
  return {
    role: 'tonborg', operation: call.operation, requestId: call.requestId,
    scope: { personalSpaceId: call.scope.personalSpaceId, personalProjectId, sessionRef: call.scope.sessionRef ?? null },
    versions: { evidence: call.evidenceVersion, policy: call.policyVersion },
    instructions: call.instructions,
    evidence: Object.entries(call.data).filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({ id: key, personalProjectId, text: JSON.stringify(value) })),
    output: { type: 'structured', schema: call.schema },
    decisions: ['propose']
  };
}
