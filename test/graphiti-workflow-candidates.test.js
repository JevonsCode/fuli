import assert from 'node:assert/strict';
import test from 'node:test';

import { FederatedGraphApplication } from '../src/graphiti/federated-application.js';

const CONFIG = {
  version: 1,
  personal: {
    providerUrl: 'http://127.0.0.1:8787',
    accessToken: 'personal-token',
    workflowObservationToken: 'mcp-host-workflow-observation-token-123456',
    principalId: 'person-local',
    spaceId: 'personal-space'
  },
  workspaces: []
};

test('federated app reads persisted workflow candidates with camel-case dimensions', async () => {
  const calls = [];
  const app = new FederatedGraphApplication(CONFIG, {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, providerCandidatePage());
    }
  });

  const result = await app.listWorkflowCandidates({
    personalSpaceId: 'personal-space',
    personalProjectId: 'travel-d',
    limit: 5
  });

  assert.deepEqual(JSON.parse(calls[0].options.body), {
    personal_space_id: 'personal-space',
    personal_project_id: 'travel-d',
    after_step_key: null,
    limit: 5
  });
  assert.deepEqual(result.candidates[0], {
    candidateId: 'candidate-1',
    candidateVersion: 1,
    evidenceRevision: 3,
    decisionRevision: 0,
    ruleFingerprint: 'rule-fingerprint-1',
    workflowKey: 'release-notes-link-check',
    condition: { releaseChannel: 'final' },
    personalSpaceId: 'personal-space',
    personalProjectId: 'travel-d',
    sourceStepId: 'step-x-id',
    sourceStepKey: 'step-x',
    sourceStepName: 'Generate release notes',
    targetStepId: 'step-y-id',
    targetStepKey: 'step-y',
    targetStepName: 'Check links',
    status: 'pending',
    occurrenceCount: 3,
    distinctSessionCount: 3,
    recency: {
      firstObservedAt: '2026-08-01T08:00:00Z',
      lastObservedAt: '2026-08-03T08:00:00Z',
      ageDays: 0,
      score: 1
    },
    confirmationAuthority: 'agent_proposed',
    negativeEvidenceCount: 0,
    declineCount: 0,
    reviewedAt: null,
    reviewReason: null,
    recommendation: {
      recommended: true,
      score: 0.9,
      threshold: 0.7,
      action: 'ask_user'
    },
    executionAuthorized: false,
    authorization: null
  });
});

function providerCandidatePage() {
  return {
    policy: {
      minimum_occurrences: 3,
      minimum_distinct_sessions: 3,
      recommendation_threshold: 0.7,
      weights: {
        occurrences: 0.45,
        distinct_sessions: 0.25,
        recency: 0.2,
        confirmation_authority: 0.1
      },
      decline_penalty: 0.25,
      negative_evidence_penalty: 0.1
    },
    candidates: [{
      candidate_id: 'candidate-1',
      candidate_version: 1,
      evidence_revision: 3,
      decision_revision: 0,
      rule_fingerprint: 'rule-fingerprint-1',
      workflow_key: 'release-notes-link-check',
      condition: { releaseChannel: 'final' },
      personal_space_id: 'personal-space',
      personal_project_id: 'travel-d',
      source_step_id: 'step-x-id',
      source_step_key: 'step-x',
      source_step_name: 'Generate release notes',
      target_step_id: 'step-y-id',
      target_step_key: 'step-y',
      target_step_name: 'Check links',
      status: 'pending',
      occurrence_count: 3,
      distinct_session_count: 3,
      recency: {
        first_observed_at: '2026-08-01T08:00:00Z',
        last_observed_at: '2026-08-03T08:00:00Z',
        age_days: 0,
        score: 1
      },
      confirmation_authority: 'agent_proposed',
      negative_evidence_count: 0,
      decline_count: 0,
      reviewed_at: null,
      review_reason: null,
      recommendation: {
        recommended: true,
        score: 0.9,
        threshold: 0.7,
        action: 'ask_user'
      },
      execution_authorized: false,
      authorization: null
    }]
  };
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
