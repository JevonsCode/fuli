export function startKnowledgeReview(app, input) {
  assertActivePersonalSpace(app, input.personalSpaceId);
  return app.personal.startKnowledgeReview({
    personal_space_id: input.personalSpaceId,
    scope: input.scope,
    personal_project_id: input.personalProjectId ?? null,
    ...(input.reviewer ? { reviewer: input.reviewer } : {})
  });
}

export function listKnowledgeReviewCandidates(app, input) {
  assertActivePersonalSpace(app, input.personalSpaceId);
  return app.personal.listKnowledgeReviewCandidates({
    personal_space_id: input.personalSpaceId,
    review_id: input.reviewId,
    limit: input.limit,
    ...(input.offset !== undefined ? { offset: input.offset } : {})
  });
}

export function recordKnowledgeReviewProgress(app, input) {
  assertActivePersonalSpace(app, input.personalSpaceId);
  return app.personal.recordKnowledgeReviewProgress({
    personal_space_id: input.personalSpaceId,
    review_id: input.reviewId,
    candidate_key: input.candidateKey,
    outcome: input.outcome,
    note: input.note ?? null,
    ...(input.aiReviewEvidenceToken ? { ai_review_evidence_token: input.aiReviewEvidenceToken } : {}),
    ...(input.aiAssessment ? { ai_assessment: input.aiAssessment } : {})
  });
}

export function finishKnowledgeReview(app, input) {
  assertActivePersonalSpace(app, input.personalSpaceId);
  return app.personal.finishKnowledgeReview({
    personal_space_id: input.personalSpaceId,
    review_id: input.reviewId,
    disposition: input.disposition
  });
}

function assertActivePersonalSpace(app, personalSpaceId) {
  if (personalSpaceId !== app.config.personal.spaceId) {
    throw new TypeError('Knowledge review must use the active personal space');
  }
}
