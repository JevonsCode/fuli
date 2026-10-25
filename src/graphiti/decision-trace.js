export async function recordDecisionTrace(application, input) {
  const trace = decisionTraceKnowledge(input);
  return application.captureSessionKnowledge({
    targetKind: 'personal',
    spaceId: input.personalSpaceId,
    personalProjectId: input.personalProjectId ?? null,
    sessionId: input.sessionId,
    idempotencyKey: input.idempotencyKey,
    name: `Decision · ${input.title}`,
    sourceKind: input.sourceKind,
    sourceDescription: input.sourceDescription,
    sourceUri: input.sourceUri ?? null,
    sourceApplication: input.sourceApplication ?? null,
    sourceTurnId: input.sourceTurnId ?? null,
    referenceTime: input.referenceTime,
    summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
    sensitivity: input.sensitivity ?? 'normal',
    ...trace
  });
}

function decisionTraceKnowledge(input) {
  const decisionKey = `decision:${input.decisionKey}`;
  const selectedKey = `${decisionKey}:option:${input.selectedOption.key}`;
  const rationaleKey = `${decisionKey}:rationale`;
  const rejected = input.rejectedOptions ?? [];
  const validations = input.validationResults ?? [];
  const confirmed = ['user', 'authoritative_source'].includes(
    input.decidedBy.kind
  );
  const confirmationStatus = confirmed ? 'confirmed' : 'pending';
  const epistemicStatus = confirmed ? 'confirmed' : 'observed';
  const confirmationBasis = {
    existenceReason: input.sourceDescription,
    quadrantReason: input.reason,
    proposedBy: input.decidedBy,
    confirmedBy: confirmed ? input.decidedBy : null,
    confirmedAt: confirmed ? input.referenceTime : null,
    agentPolicyVersion: null
  };
  const epistemic = {
    originQuadrant: 'known_known',
    currentQuadrant: 'known_known',
    epistemicStatus,
    confirmationStatus,
    confirmationBasis,
    reasoningSummary: input.reason,
    inheritanceMode: 'local_only',
    inheritedProjectIds: []
  };
  const entities = [
    {
      key: decisionKey,
      name: input.title,
      type: 'Decision',
      summary: `${input.question}\nSelected: ${input.selectedOption.label}`,
      attributes: {
        decisionKey: input.decisionKey,
        selectedOptionKey: input.selectedOption.key,
        decidedByKind: input.decidedBy.kind
      },
      ...epistemic
    },
    {
      key: selectedKey,
      name: input.selectedOption.label,
      type: 'DecisionOption',
      summary: input.selectedOption.summary ?? '',
      attributes: { disposition: 'selected' },
      ...epistemic
    },
    ...rejected.map((option) => ({
      key: `${decisionKey}:option:${option.key}`,
      name: option.label,
      type: 'DecisionOption',
      summary: option.summary ?? '',
      attributes: { disposition: 'rejected' },
      ...epistemic
    })),
    {
      key: rationaleKey,
      name: `${input.title} · rationale`,
      type: 'DecisionRationale',
      summary: input.reason,
      attributes: {},
      ...epistemic
    },
    ...validations.map((validation) => ({
      key: `${decisionKey}:validation:${validation.key}`,
      name: `${input.title} · ${validation.key}`,
      type: 'ValidationResult',
      summary: validation.summary,
      attributes: { outcome: validation.outcome },
      ...epistemic
    }))
  ];
  const relationship = (key, target, type, fact) => ({
    key,
    source: decisionKey,
    target,
    type,
    fact,
    confidence: confirmed ? 1 : 0.7,
    attributes: {},
    ...epistemic
  });
  return {
    entities,
    relationships: [
      relationship(
        `${decisionKey}:selected`,
        selectedKey,
        'SELECTED_OPTION',
        `${input.title} selected ${input.selectedOption.label}.`
      ),
      ...rejected.map((option) => relationship(
        `${decisionKey}:rejected:${option.key}`,
        `${decisionKey}:option:${option.key}`,
        'REJECTED_OPTION',
        `${input.title} did not select ${option.label}.`
      )),
      relationship(
        `${decisionKey}:motivated-by`,
        rationaleKey,
        'MOTIVATED_BY',
        input.reason
      ),
      ...validations.map((validation) => relationship(
        `${decisionKey}:validated-by:${validation.key}`,
        `${decisionKey}:validation:${validation.key}`,
        'VALIDATED_BY',
        `${validation.outcome}: ${validation.summary}`
      ))
    ]
  };
}
