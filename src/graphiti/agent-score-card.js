import { reviewAgentScoreCard } from './agent-performance-review.js';

// Bole's zero-token score card. The Provider tallies the outcomes it records;
// this host adds the Tonborg acceptance verdicts it keeps locally. Nothing is
// written and no model runs, unless review asks Bole's own model for a
// suggestion. Task IDs stay behind a separate drill-down read.

// The same read tool returns the task IDs once a dimension is added.
const EVIDENCE_TOOL = 'get_agent_score_card';
const DEFAULT_EVIDENCE_LIMIT = 50;
const DIMENSIONS = Object.freeze({
  completion: 'completion', firstPass: 'first_pass', userFeedback: 'user_feedback', review: 'review'
});
const DIMENSION_NAMES = Object.freeze(Object.fromEntries(
  Object.entries(DIMENSIONS).map(([name, providerName]) => [providerName, name])));

export async function getAgentScoreCard(application, input) {
  const value = await application.personal.getProjectAgentScoreCard(scoreCardQuery(application, input));
  const card = {
    personalSpaceId: value.personal_space_id,
    agentId: value.agent_id,
    personalProjectIds: value.personal_project_ids,
    minimumSample: value.minimum_sample,
    dimensions: Object.fromEntries(Object.entries(DIMENSIONS)
      .map(([name, providerName]) => [name, dimensionRecord(value.dimensions[providerName])])),
    executors: value.executors.map(item => ({ executorId: item.executor_id, evidenceCount: item.evidence_count })),
    toolFlags: value.tool_flags.map(flag => ({
      dimension: DIMENSION_NAMES[flag.dimension], executorId: flag.executor_id, rate: flag.rate, sample: flag.sample,
      comparedExecutorId: flag.compared_executor_id, comparedRate: flag.compared_rate,
      comparedSample: flag.compared_sample, suggestion: flag.suggestion
    })),
    disputedReviewCount: value.disputed_review_count,
    staleReviewCount: value.stale_review_count,
    asOf: value.as_of,
    evidence: { tool: EVIDENCE_TOOL, addArgument: 'dimension', arguments: { personalSpaceId: value.personal_space_id,
      agentId: value.agent_id, ...(input.personalProjectId ? { personalProjectId: input.personalProjectId } : {}) } }
  };
  return input.review ? reviewAgentScoreCard(application, card) : card;
}

export async function listAgentScoreEvidence(application, input) {
  const dimension = DIMENSIONS[input.dimension];
  if (!dimension) throw new TypeError(`Score card dimension must be one of ${Object.keys(DIMENSIONS).join(', ')}`);
  const value = await application.personal.listProjectAgentScoreEvidence({ ...scoreCardQuery(application, input),
    dimension, executor_id: input.executorId ?? null, limit: input.limit ?? DEFAULT_EVIDENCE_LIMIT });
  return {
    personalSpaceId: value.personal_space_id,
    agentId: value.agent_id,
    personalProjectIds: value.personal_project_ids,
    dimension: DIMENSION_NAMES[value.dimension],
    executorId: value.executor_id,
    passed: taskList(value.passed),
    notPassed: taskList(value.not_passed),
    truncated: value.truncated
  };
}

function scoreCardQuery(application, input) {
  const personalProjectId = input.personalProjectId ?? null;
  return {
    personal_space_id: input.personalSpaceId,
    agent_id: input.agentId,
    personal_project_ids: personalProjectId ? [personalProjectId] : null,
    review_verdicts: application.judgment?.reviewVerdicts({
      personalSpaceId: input.personalSpaceId, agentId: input.agentId, personalProjectId
    }) ?? []
  };
}

function dimensionRecord(value) {
  return value.status === 'scored'
    ? { status: value.status, sample: value.sample, passed: value.passed, rate: value.rate,
      tier: { label: value.tier.label, evidenceCount: value.tier.evidence_count } }
    : { status: value.status, sample: value.sample, label: value.label };
}

function taskList(value) {
  return { count: value.count, taskIds: value.task_ids };
}
