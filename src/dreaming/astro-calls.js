import { contentHash } from '../../packages/roundtable/src/canonical-json.js';

// What Astro's own-model work outside any task shares (Dreaming over a
// project's sessions, the retrospective of a finished task): the request the
// model port takes, and the one log row per run the console shows. Both run
// under Astro's Dreaming permission: its switch, its approved projects, its budget.

export const ASSISTANT_ROLE = 'assistant';
export const DREAMING_OPERATION = 'dreaming';

export const dreamingSettings = application => application.modelBackends?.operationSettings(ASSISTANT_ROLE, DREAMING_OPERATION) ?? null;
// Whether Astro has a model with Dreaming on, whatever the project.
export const dreamingConnected = application => Boolean(dreamingSettings(application));

// kind names the work in the request ID, so a retrospective and a Dreaming
// run over the same evidence are never one request.
export function astroRequest({ kind, personalSpaceId, personalProjectId, evidence, instructions, schema, promptVersion, decisions, timeoutMs }) {
  const scope = { personalSpaceId, personalProjectId, sessionRef: null };
  const evidenceVersion = contentHash(evidence);
  return { role: ASSISTANT_ROLE, operation: DREAMING_OPERATION,
    requestId: `${kind}:${contentHash({ scope, evidenceVersion, promptVersion })}`,
    scope, versions: { evidence: evidenceVersion, policy: promptVersion }, instructions, evidence,
    output: { type: 'structured', schema }, decisions, budget: { timeoutMs } };
}

// One row per run in the built-in Agents' suggestion log: what the console shows.
// A run outlasts the recovery proof, so the gate is checked again here. The log
// may be closed while a delete is checked; the run's result still stands.
export async function recordAstroRun(application, { operation, personalProjectId, subject, result, deletionGeneration }) {
  try {
    await application.knowledgeRecoveryGate?.refresh(application.config.personal.spaceId);
    application.roleSuggestions?.record({ role: ASSISTANT_ROLE, operation, personalSpaceId: application.config.personal.spaceId,
      personalProjectId, subject, result, ...(deletionGeneration === undefined ? {} : { deletionGeneration }) });
    return result;
  } catch {
    return { ...result, recorded: false };
  }
}

// A lesson as a pending item in the person's review queue: Astro proposes, the
// person confirms or drops it. key keeps a retried run from queueing it twice.
export function pendingLesson({ personalSpaceId, personalProjectId, kind, key, sessionId, name, title, text, reason, attributes, now }) {
  const at = now.toISOString();
  return { targetKind: 'personal', spaceId: personalSpaceId, personalProjectId, sessionId,
    idempotencyKey: key, name, sourceKind: kind, sourceDescription: reason, sourceUri: null,
    sourceApplication: 'other', referenceTime: at, summary: text, sensitivity: 'normal', relationships: [],
    entities: [{ key, name: title, type: 'Knowledge', summary: text, originQuadrant: 'known_known', currentQuadrant: 'known_known',
      epistemicStatus: 'observed', confirmationStatus: 'pending', reasoningSummary: reason, inheritanceMode: 'local_only', inheritedProjectIds: [],
      confirmationBasis: { existenceReason: reason, quadrantReason: reason, proposedBy: { kind: 'agent', label: kind }, confirmedBy: null,
        confirmedAt: null, agentPolicyVersion: null }, attributes }] };
}
