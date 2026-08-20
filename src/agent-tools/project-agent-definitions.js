import {
  arraySchema,
  booleanSchema,
  enumSchema,
  integerSchema,
  nullableStringSchema,
  objectSchema,
  stringSchema
} from './schema.js';

const id = boundedString(256);
const shortText = boundedString(2048);
const idempotencyKey = { ...boundedString(256), minLength: 8 };
const dateTime = { ...boundedString(64), format: 'date-time' };
const sourceApplication = {
  type: ['string', 'null'],
  enum: ['codex', 'claude_code', 'cursor', 'kiro', 'other', null]
};

const projectAgentStatus = enumSchema(['active', 'inactive', 'archived']);
export const nullableProjectAgentStatus = {
  type: ['string', 'null'],
  enum: ['active', 'inactive', 'archived', null]
};
const projectAgentExecutorPolicy = objectSchema({
  mode: enumSchema(['flexible', 'locked']),
  lockedExecutorIds: arraySchema(id, { maxItems: 32 }),
  preferredExecutorIds: arraySchema(id, { maxItems: 32 })
});
export const projectAgentModelStrategy = objectSchema({
  mode: enumSchema(['adaptive', 'fast', 'balanced', 'deep']),
  reasoningEffort: enumSchema(['default', 'low', 'medium', 'high']),
  capabilityHints: arraySchema(boundedString(128), { maxItems: 16 })
});
export const projectAgentProfile = objectSchema({
  name: boundedString(160),
  responsibility: boundedString(4096),
  occupationEmoji: { ...nullableStringSchema(), minLength: 1, maxLength: 32 },
  agentType: enumSchema(['coordinator', 'durable', 'hr', 'temporary']),
  workKinds: arraySchema(boundedString(512), { maxItems: 32 }),
  capabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  initialPreferences: arraySchema(boundedString(512), { maxItems: 32 }),
  defaultModelStrategy: projectAgentModelStrategy,
  executorPolicy: projectAgentExecutorPolicy,
  allowedClients: arraySchema(
    enumSchema(['codex', 'claude_code', 'cursor', 'kiro', 'other']),
    { maxItems: 5 }
  ),
  testSource: nullableStringSchema(),
  cleanupEligible: booleanSchema(),
  status: projectAgentStatus
}, ['name', 'responsibility']);

export const projectAgentAssignmentStatus = enumSchema(['active', 'ended']);
export const projectAgentAssignmentInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  agentId: id,
  idempotencyKey,
  responsibility: boundedString(4096),
  workKinds: arraySchema(boundedString(512), { maxItems: 32 }),
  capabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  modelStrategyOverride: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  executorPolicyOverride: { ...projectAgentExecutorPolicy, type: ['object', 'null'] },
  reason: shortText,
  sourceApplication,
  sourceSessionId: nullableStringSchema()
}, ['personalSpaceId', 'personalProjectId', 'agentId', 'idempotencyKey', 'responsibility', 'reason']);
export const projectAgentAssignmentEndInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  assignmentId: id,
  expectedRevision: integerSchema({ minimum: 0 }),
  reason: shortText
}, ['personalSpaceId', 'personalProjectId', 'assignmentId', 'expectedRevision', 'reason']);
export const projectAgentAssignmentReplaceInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  assignmentId: id,
  expectedRevision: integerSchema({ minimum: 0 }),
  replacementAgentId: id,
  idempotencyKey,
  responsibility: boundedString(4096),
  workKinds: arraySchema(boundedString(512), { maxItems: 32 }),
  capabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  modelStrategyOverride: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  executorPolicyOverride: { ...projectAgentExecutorPolicy, type: ['object', 'null'] },
  reason: shortText,
  sourceApplication,
  sourceSessionId: nullableStringSchema()
}, [
  'personalSpaceId', 'personalProjectId', 'idempotencyKey',
  'responsibility', 'reason', 'assignmentId', 'expectedRevision', 'replacementAgentId'
]);
const projectAgentTaskStatus = enumSchema([
  'awaiting_recruitment', 'queued', 'running', 'paused', 'failed',
  'awaiting_review', 'blocked', 'completed', 'cancelled'
]);
const projectAgentTaskDuration = enumSchema(['ongoing', 'one_off']);
const projectAgentStaffingIntent = enumSchema([
  'reuse_preferred', 'new_durable', 'temporary', 'unassigned'
]);
const projectAgentTaskComplexity = enumSchema(['simple', 'standard', 'complex']);
const projectAgentParallelPlan = objectSchema({
  enabled: booleanSchema(),
  independentVerification: booleanSchema(),
  conflictFreeScopes: booleanSchema(),
  reason: nullableStringSchema(),
  workstreamBoundaries: arraySchema(shortText, { maxItems: 16 })
});
export const projectAgentTaskSubmitInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  idempotencyKey,
  title: boundedString(160),
  objective: boundedString(4096),
  workKind: boundedString(128),
  requiredCapabilities: arraySchema(boundedString(512), { maxItems: 16 }),
  duration: projectAgentTaskDuration,
  staffingIntent: projectAgentStaffingIntent,
  leadAgentId: nullableStringSchema(),
  collaboratorAgentIds: arraySchema(id, { maxItems: 16 }),
  coordinatorAgentId: nullableStringSchema(),
  complexityHint: { ...projectAgentTaskComplexity, type: ['string', 'null'] },
  parallelPlan: projectAgentParallelPlan,
  modelStrategyOverride: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  executorPolicyOverride: { ...projectAgentExecutorPolicy, type: ['object', 'null'] },
  sourceApplication,
  sourceSessionId: nullableStringSchema(),
  routingReason: shortText,
  recruitmentProfile: { ...projectAgentProfile, type: ['object', 'null'] }
}, [
  'personalSpaceId', 'personalProjectId', 'idempotencyKey', 'title', 'objective',
  'workKind', 'routingReason'
]);
export const projectAgentTaskCoordinateInput = objectSchema({
  projectPath: boundedString(4096),
  idempotencyKey,
  title: boundedString(160),
  objective: boundedString(4096),
  workKind: boundedString(128),
  requiredCapabilities: arraySchema(boundedString(512), { maxItems: 16 }),
  duration: projectAgentTaskDuration,
  staffingIntent: projectAgentStaffingIntent,
  leadAgentId: nullableStringSchema(),
  collaboratorAgentIds: arraySchema(id, { maxItems: 16 }),
  coordinatorAgentId: nullableStringSchema(),
  complexityHint: { ...projectAgentTaskComplexity, type: ['string', 'null'] },
  parallelPlan: projectAgentParallelPlan,
  modelStrategyOverride: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  executorPolicyOverride: { ...projectAgentExecutorPolicy, type: ['object', 'null'] },
  routingReason: shortText,
  recruitmentProfile: { ...projectAgentProfile, type: ['object', 'null'] },
  contextQueries: arraySchema(shortText, { minItems: 1, maxItems: 10 }),
  contextLimitPerQuery: integerSchema({ minimum: 1, maximum: 20 }),
  includePendingContext: booleanSchema()
}, [
  'projectPath', 'idempotencyKey', 'title', 'objective', 'workKind',
  'routingReason', 'contextQueries'
]);
export const projectAgentTaskActivityInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  taskId: id,
  idempotencyKey,
  expectedRevision: integerSchema({ minimum: 0 }),
  status: projectAgentTaskStatus,
  summary: shortText,
  agentId: nullableStringSchema(),
  actorKind: enumSchema(['agent', 'human']),
  sourceApplication,
  sourceSessionId: nullableStringSchema(),
  actualExecutor: nullableStringSchema(),
  actualModelProvider: nullableStringSchema(),
  actualModel: nullableStringSchema(),
  routingRuleId: nullableStringSchema(),
  fallbackReason: nullableStringSchema(),
  actualExecutorId: nullableStringSchema(),
  matchedExecutorRuleId: nullableStringSchema(),
  executorSelectionReason: nullableStringSchema(),
  executorFallbackReason: nullableStringSchema(),
  executorBlockedReason: nullableStringSchema(),
  workerId: { ...nullableStringSchema(), minLength: 1, maxLength: 128 },
  workerLabel: { ...nullableStringSchema(), minLength: 1, maxLength: 160 },
  workerOccupationEmoji: { ...nullableStringSchema(), minLength: 1, maxLength: 32 },
  workerStatus: { ...projectAgentTaskStatus, type: ['string', 'null'] }
}, [
  'personalSpaceId', 'personalProjectId', 'taskId', 'idempotencyKey', 'status', 'summary'
]);
export const recruitmentConfirmationMode = enumSchema(['automatic', 'require_confirmation']);
const recruitmentPositionKind = enumSchema(['durable', 'temporary']);
export const recruitmentStatus = enumSchema([
  'awaiting_confirmation', 'requested', 'fulfilled', 'cancelled', 'blocked', 'no_hr'
]);
export const recruitmentDecision = enumSchema(['approve', 'cancel']);
const executorRegistrationStatus = enumSchema(['registered', 'disabled', 'revoked']);
const executorPermissionStatus = enumSchema(['pending', 'authorized', 'denied', 'revoked']);
const executorPreflightStatus = enumSchema(['not_run', 'passed', 'failed', 'expired']);
export const executorHealthStatus = enumSchema(['unknown', 'healthy', 'degraded', 'unhealthy']);
export const executorAuthorizationStatus = enumSchema(['pending', 'authorized', 'denied', 'revoked']);
const executorActualModelStrategySource = enumSchema([
  'task', 'assignment', 'agent', 'routing_rule', 'coordinator'
]);
export const executorModel = objectSchema({
  provider: boundedString(128),
  model: boundedString(256),
  capabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  strategyModes: arraySchema(enumSchema(['adaptive', 'fast', 'balanced', 'deep']), { maxItems: 4 }),
  reasoningEfforts: arraySchema(enumSchema(['default', 'low', 'medium', 'high']), { maxItems: 4 }),
  available: booleanSchema(),
  observedAt: nullableStringSchema(),
  sourceApplication,
  unavailableReason: nullableStringSchema()
}, ['provider', 'model']);
export const executorProfile = objectSchema({
  personalSpaceId: id,
  executorId: id,
  displayName: boundedString(160),
  executorKind: boundedString(128),
  capabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  advertisedModels: arraySchema(executorModel, { maxItems: 64 }),
  globalPriority: integerSchema({ minimum: 1, maximum: 1000000 }),
  healthRequired: booleanSchema(),
  expectedRevision: integerSchema({ minimum: 0 }),
  idempotencyKey,
  sourceApplication,
  sourceSessionId: nullableStringSchema(),
  testSource: nullableStringSchema(),
  cleanupEligible: booleanSchema()
}, ['personalSpaceId', 'executorId', 'displayName', 'idempotencyKey']);
export const routingRuleScope = enumSchema(['global', 'space', 'project', 'task']);
export const executorRoutingRuleInput = objectSchema({
  personalSpaceId: id,
  scope: routingRuleScope,
  personalProjectId: nullableStringSchema(),
  taskId: nullableStringSchema(),
  workKind: boundedString(128),
  requiredCapabilities: arraySchema(boundedString(512), { maxItems: 32 }),
  executorIds: arraySchema(id, { minItems: 1, maxItems: 32 }),
  modelStrategy: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  priority: integerSchema({ minimum: 1, maximum: 1000000 }),
  reason: shortText,
  idempotencyKey
}, ['scope', 'workKind', 'reason', 'idempotencyKey']);
export const executorActualReportInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  taskId: id,
  runId: id,
  agentId: id,
  executorId: id,
  provider: boundedString(128),
  model: boundedString(256),
  modelStrategy: projectAgentProfile.properties.defaultModelStrategy,
  modelStrategySource: executorActualModelStrategySource,
  matchedRuleId: nullableStringSchema(),
  fallbackReason: nullableStringSchema(),
  idempotencyKey,
  occurredAt: dateTime,
  sourceApplication,
  sourceSessionId: nullableStringSchema()
}, [
  'personalSpaceId', 'personalProjectId', 'taskId', 'runId', 'agentId',
  'executorId', 'provider', 'model', 'idempotencyKey', 'occurredAt'
]);
const outcomeEvidenceKind = enumSchema([
  'terminal_outcome',
  'rework_requested', 'repeated_negative_feedback', 'explicit_praise',
  'test_passed', 'test_failed', 'acceptance_passed', 'acceptance_failed', 'explicit_rating'
]);
const outcomeEvidenceSource = enumSchema(['system_terminal', 'user_explicit', 'test_fact']);
const outcomeTerminalStatus = enumSchema(['completed', 'failed', 'cancelled']);
export const projectAgentTaskOutcomeInput = objectSchema({
  personalSpaceId: id,
  personalProjectId: id,
  workKind: boundedString(128),
  agentId: id,
  executorId: id,
  taskId: id,
  runId: nullableStringSchema(),
  idempotencyKey,
  modelStrategy: { ...projectAgentProfile.properties.defaultModelStrategy, type: ['object', 'null'] },
  evidenceKind: outcomeEvidenceKind,
  source: outcomeEvidenceSource,
  terminalOutcome: { ...outcomeTerminalStatus, type: ['string', 'null'] },
  rating: { ...integerSchema({ minimum: 1, maximum: 5 }), type: ['integer', 'null'] },
  referenceIds: arraySchema(id, { maxItems: 16 }),
  note: nullableStringSchema(),
  occurredAt: dateTime
}, [
  'personalSpaceId', 'personalProjectId', 'workKind', 'agentId', 'executorId', 'taskId',
  'idempotencyKey', 'evidenceKind', 'source', 'occurredAt'
]);

// Keep the complete state vocabulary in one place even when a state schema is
// currently represented only in Provider responses rather than tool inputs.
export const projectAgentResponseStateSchemas = {
  recruitmentPositionKind,
  executorRegistrationStatus,
  executorPermissionStatus,
  executorPreflightStatus,
  executorHealthStatus
};

function boundedString(maxLength) {
  return { ...stringSchema(), minLength: 1, maxLength };
}
