import { z } from 'zod';

import { EmployeeError } from '../employees/manifest.js';

// What a runner's Tonborg decided (docs/runner.md, "Executor judgment on a
// runner"), delivered from its outbox and kept here among Tonborg's routing
// records, so the person sees it in Tonborg's workbench and later judgments
// read how it turned out. A decision is recorded once per runner and id; the
// outcome the runner reports becomes the decision's feedback, marked as the
// runner's report (reportedBy), never as the person's vote. Nothing here
// judges again, starts anything or writes knowledge.
const id = z.string().min(1).max(256);
const text = maximum => z.string().max(maximum);
const selection = z.object({ executorId: id, model: text(200), client: text(64) }).strict().nullable();
const receipt = z.object({ backend: text(64).nullable().optional(), status: text(64), reason: text(128).nullable().optional(),
  failureClass: text(64).nullable().optional(), fallbackReason: text(128).nullable().optional(),
  requestedModel: text(200).nullable().optional(), actualModel: text(200).nullable().optional(),
  attempts: z.number().int().min(0).max(100).optional(), usage: z.record(z.string(), z.unknown()).optional() }).strict();
export const RUNNER_DECISION_SCHEMA = z.object({
  id, kind: z.literal('routing'), decidedOn: z.literal('runner'), createdAt: z.string().datetime(),
  personalSpaceId: id, personalProjectId: id, requestId: id, target: z.enum(['subagent', 'session', 'client']),
  agentId: id, workKind: id, objective: text(8000), taskId: id.optional(),
  outcome: z.enum(['recommend', 'escalate']),
  disposition: z.enum(['continue_current', 'reuse_conversation', 'new_session', 'delegate', 'ask_user']),
  conversationId: z.null(), summary: text(2000), evidence: z.array(text(1000)).max(8), selection,
  executionRequired: z.boolean(), leftOut: z.array(z.object({ executorId: id, reason: text(64) }).strict()).max(32).optional(),
  model: text(200).nullable(), judgedBy: z.object({ mode: z.literal('model_api'), independent: z.literal(true) }).strict().optional(),
  modelReceipt: receipt.optional()
}).strict();
export const RUNNER_OUTCOME_SCHEMA = z.object({ personalSpaceId: id, decisionId: id, vote: z.enum(['up', 'down']),
  reason: z.string().trim().min(1).max(1000) }).strict();

const requestKey = (runner, decisionId) => `runner-routing:${runner.fingerprint}:${decisionId}`;

// decision: checked with RUNNER_DECISION_SCHEMA; runner: { fingerprint, name } of the runner that sent it.
export function recordRunnerDecision(store, decision, runner) {
  const { id: decisionId, createdAt: decidedAt, ...body } = decision;
  return store.record(decision.personalSpaceId, { ...body, decidedAt, runnerDecisionId: decisionId,
    runner: { fingerprint: runner.fingerprint, name: runner.name },
    guidance: 'A runner\'s Tonborg recommended this with its own model among that computer\'s executors. '
      + 'It is not execution; the runner records what really ran.' }, requestKey(runner, decisionId));
}

// The runner's report of how its choice did (RUNNER_OUTCOME_SCHEMA), as that decision's feedback.
export function recordRunnerOutcome(store, report, runner) {
  const record = store.recordFor(report.personalSpaceId, requestKey(runner, report.decisionId));
  if (!record) throw new EmployeeError('This runner sent no decision with that id', 404, 'not_found');
  return store.feedback(report.personalSpaceId, record.id, report.vote, report.reason, record.feedback.revision,
    { relayedBy: `runner:${runner.fingerprint}`, personWords: null });
}
