import { createHash } from 'node:crypto';

const FORBIDDEN_AGENT_FIELDS = [
  'sessionId',
  'idempotencyKey',
  'observedAt',
  'occurrenceCount',
  'distinctSessionCount',
  'confirmationAuthority',
  'authority',
  'durableAuthorizationConfirmed',
  'approvalToken'
];

export function providerWorkflowTransitionObservation(input) {
  for (const field of FORBIDDEN_AGENT_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new TypeError(
        `Workflow observations cannot submit host, aggregate, or authority field: ${field}`
      );
    }
  }
  assertHostValue(input.hostSessionId, 'hostSessionId');
  assertHostValue(input.hostObservedAt, 'hostObservedAt');
  const condition = input.condition ?? {};
  const observationId = workflowObservationId({
    hostSessionId: input.hostSessionId,
    personalProjectId: input.personalProjectId ?? null,
    workflowKey: input.workflowKey,
    fromActionId: input.fromStep.actionId,
    toActionId: input.toStep.actionId,
    condition
  });
  return {
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId ?? null,
    host_session_id: input.hostSessionId,
    observation_id: observationId,
    from_step: providerStep(input.fromStep),
    to_step: providerStep(input.toStep),
    workflow_key: input.workflowKey,
    condition,
    observed_at: input.hostObservedAt,
    evidence_summary: input.evidenceSummary,
    source_application: input.sourceApplication ?? null,
    source_turn_id: input.sourceTurnId ?? null,
    sensitivity: input.sensitivity ?? 'normal'
  };
}

function providerStep(step) {
  return {
    action_id: step.actionId,
    name: step.name,
    summary: step.summary ?? null
  };
}

function workflowObservationId(value) {
  const digest = createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex');
  return `workflow-observation:${digest}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertHostValue(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be injected by the MCP host`);
  }
}
