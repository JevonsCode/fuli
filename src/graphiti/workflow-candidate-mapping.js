export function providerWorkflowCandidateSearch(input) {
  return {
    personal_space_id: input.personalSpaceId,
    personal_project_id: input.personalProjectId ?? null,
    after_step_key: input.afterStepKey ?? null,
    limit: input.limit ?? 20
  };
}

export function workflowCandidatePage(value) {
  return {
    policy: workflowRecommendationPolicy(value.policy),
    candidates: value.candidates.map(workflowCandidate)
  };
}

export function workflowCandidate(value) {
  return {
    candidateId: value.candidate_id,
    candidateVersion: value.candidate_version,
    evidenceRevision: value.evidence_revision,
    decisionRevision: value.decision_revision,
    ruleFingerprint: value.rule_fingerprint,
    workflowKey: value.workflow_key,
    condition: value.condition,
    personalSpaceId: value.personal_space_id,
    personalProjectId: value.personal_project_id ?? null,
    sourceStepId: value.source_step_id,
    sourceStepKey: value.source_step_key,
    sourceStepName: value.source_step_name,
    targetStepId: value.target_step_id,
    targetStepKey: value.target_step_key,
    targetStepName: value.target_step_name,
    status: value.status,
    occurrenceCount: value.occurrence_count,
    distinctSessionCount: value.distinct_session_count,
    recency: {
      firstObservedAt: value.recency.first_observed_at,
      lastObservedAt: value.recency.last_observed_at,
      ageDays: value.recency.age_days,
      score: value.recency.score
    },
    confirmationAuthority: value.confirmation_authority,
    negativeEvidenceCount: value.negative_evidence_count,
    declineCount: value.decline_count,
    reviewedAt: value.reviewed_at ?? null,
    reviewReason: value.review_reason ?? null,
    recommendation: value.recommendation,
    executionAuthorized: value.execution_authorized,
    authorization: value.authorization
      ? workflowAuthorization(value.authorization)
      : null
  };
}

function workflowRecommendationPolicy(value) {
  return {
    minimumOccurrences: value.minimum_occurrences,
    minimumDistinctSessions: value.minimum_distinct_sessions,
    recommendationThreshold: value.recommendation_threshold,
    weights: {
      occurrences: value.weights.occurrences,
      distinctSessions: value.weights.distinct_sessions,
      recency: value.weights.recency,
      confirmationAuthority: value.weights.confirmation_authority
    },
    declinePenalty: value.decline_penalty,
    negativeEvidencePenalty: value.negative_evidence_penalty
  };
}

function workflowAuthorization(value) {
  return {
    authorizationId: value.authorization_id,
    candidateId: value.candidate_id,
    candidateVersion: value.candidate_version,
    ruleId: value.rule_id,
    ruleFingerprint: value.rule_fingerprint,
    scope: value.scope,
    active: value.active,
    authority: value.authority,
    createdAt: value.created_at,
    highRiskPerCallApprovalRequired:
      value.high_risk_per_call_approval_required,
    highRiskActionCategories: value.high_risk_action_categories
  };
}
