import { createRoleTrust } from '../../src/model-backends/role-trust.js';

// Tonborg configured with a synthetic model whose trust warning the person
// acknowledged (rec#10 D-36), for tests of the automatic review path. The
// model port is a stand-in: no model is called.
const FIXTURE_MODEL = 'fixture-model';
// The warning version the settings page shows (a role's trust.warningVersion).
export const WARNING_VERSION = 1;

// What the judgment backend reports for an answer from that configured model.
export const MODEL_ANSWER = Object.freeze({ status: 'answered', mode: 'model_api', independent: true, model: FIXTURE_MODEL,
  modelReceipt: { backend: 'model_api', status: 'answered', requestedModel: FIXTURE_MODEL, actualModel: FIXTURE_MODEL } });

// A stand-in port where Tonborg sends knowledge_review to that model and every egress check passes.
export function trustedTonborg() {
  const trust = createRoleTrust({ modelBackends: { allowsEgress: () => true,
    operationSettings: (role, operation) => role === 'tonborg' && operation === 'knowledge_review'
      ? { connection: { model: FIXTURE_MODEL } } : null } });
  trust.acknowledgeWarning('tonborg', WARNING_VERSION, 0);
  return trust;
}
