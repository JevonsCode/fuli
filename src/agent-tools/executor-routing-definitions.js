import {
  executorActualReportInput,
  executorAuthorizationStatus,
  executorHealthStatus,
  executorModel,
  executorProfile,
  executorRoutingRuleInput,
  projectAgentModelStrategy,
  projectAgentTaskOutcomeInput,
  routingRuleScope
} from './project-agent-definitions.js';
import { dateTime, id, shortText, sourceApplication } from './graph-tool-fields.js';
import { arraySchema, booleanSchema, boundedString, enumSchema, integerSchema, nullableStringSchema, objectSchema }
  from './schema.js';

const idempotencyKey = { ...boundedString(256), minLength: 8 };

// Executors, the rules that route work to them, and what routing learned.
export const EXECUTOR_ROUTING_DEFINITIONS = [
  {
    name: 'upsert_executor',
    title: 'WRITE · Register executor',
    description: 'Create or update one provider-neutral executor directory entry. Registration is configuration and authorization metadata; it does not claim the executor is connected or running.',
    inputSchema: executorProfile
  },
  {
    name: 'list_executors',
    title: 'READ · List executors',
    description: 'List executor directory entries with separate registration, permission, preflight, and health states. A connected field is returned only when the Provider has evidence; missing connected evidence stays absent.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      capability: nullableStringSchema(),
      availableOnly: booleanSchema()
    }, ['personalSpaceId'])
  },
  {
    name: 'get_executor',
    title: 'READ · Get executor',
    description: 'Inspect one executor directory entry and its preflight/audit fields without probing or fabricating a live connection.',
    inputSchema: objectSchema({ personalSpaceId: id, executorId: id }, ['personalSpaceId', 'executorId'])
  },
  {
    name: 'delete_executor',
    title: 'WRITE · Archive executor',
    description: 'Archive one executor directory entry through the Provider while retaining routing and outcome audit history.',
    inputSchema: objectSchema({ personalSpaceId: id, executorId: id }, ['personalSpaceId', 'executorId'])
  },
  {
    name: 'preflight_executor',
    title: 'WRITE · Report executor preflight',
    description: 'Record a real executor preflight report. The Provider verifies workspace permission and at least one advertised model before marking preflight passed; this tool never invokes work or fabricates availability.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: enumSchema(['passed', 'failed']),
      workspacePermission: booleanSchema(),
      capabilities: arraySchema(boundedString(512), { maxItems: 64 }),
      availableModels: arraySchema(executorModel, { maxItems: 64 }),
      reason: nullableStringSchema(),
      checkedAt: dateTime,
      idempotencyKey,
      sourceApplication,
      sourceSessionId: nullableStringSchema()
    }, ['personalSpaceId', 'executorId', 'status', 'workspacePermission', 'idempotencyKey', 'checkedAt'])
  },
  {
    name: 'authorize_executor',
    title: 'WRITE · Authorize executor workspace',
    description: 'Persist an explicit executor permission decision. Authorization is auditable metadata and does not claim the executor is connected or healthy.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: executorAuthorizationStatus,
      reason: shortText,
      expectedRevision: integerSchema({ minimum: 0 }),
      idempotencyKey
    }, ['personalSpaceId', 'executorId', 'status', 'reason', 'idempotencyKey'])
  },
  {
    name: 'report_executor_health',
    title: 'WRITE · Report executor health',
    description: 'Record a real executor health observation with its timestamp and source. This does not fabricate a connection or execute work.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      executorId: id,
      status: executorHealthStatus,
      reason: nullableStringSchema(),
      checkedAt: dateTime,
      idempotencyKey,
      sourceApplication,
      sourceSessionId: nullableStringSchema()
    }, ['personalSpaceId', 'executorId', 'status', 'checkedAt', 'idempotencyKey'])
  },
  {
    name: 'record_project_agent_executor_actual',
    title: 'WRITE · Report actual executor use',
    description: 'Record one real executor/model report after execution. The Provider rejects reports unless the executor is registered and the model was available in a passing preflight; Agent locked policy is checked before the report is accepted. Provider/model/client attribution is retained as audit evidence.',
    inputSchema: executorActualReportInput
  },
  {
    name: 'upsert_executor_routing_rule',
    title: 'WRITE · Configure executor routing rule',
    description: 'Create or update one explicit space, project, or task routing rule. Agent locked allow-lists outrank all other rules; user rules outrank coordinator rules; the default rule set is empty and no work-kind mapping is hardcoded.',
    inputSchema: executorRoutingRuleInput
  },
  {
    name: 'update_executor_routing_rule',
    title: 'WRITE · Update executor routing rule',
    description: 'Update one routing rule status with an expected revision. Existing task decisions and outcome evidence remain immutable.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      ruleId: id,
      expectedRevision: integerSchema({ minimum: 0 }),
      status: enumSchema(['active', 'disabled', 'ended']),
      reason: shortText,
      idempotencyKey
    }, ['personalSpaceId', 'ruleId', 'expectedRevision', 'status', 'reason', 'idempotencyKey'])
  },
  {
    name: 'list_executor_routing_rules',
    title: 'READ · List executor routing rules',
    description: 'List routing rules in explicit space → project → task scope order. Agent locked allow-lists outrank every scope; explicit user priority outranks coordinator defaults. The result includes source owner and actual fallback audit.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      scope: { ...routingRuleScope, type: ['string', 'null'] },
      personalProjectId: nullableStringSchema(),
      taskId: nullableStringSchema(),
      status: {
        type: ['string', 'null'],
        enum: ['active', 'disabled', 'ended', null]
      }
    }, ['personalSpaceId'])
  },
  {
    name: 'get_executor_routing_rule',
    title: 'READ · Get routing rule',
    description: 'Read one routing rule and its audit metadata without applying it locally.',
    inputSchema: objectSchema({ personalSpaceId: id, ruleId: id }, ['personalSpaceId', 'ruleId'])
  },
  {
    name: 'delete_executor_routing_rule',
    title: 'WRITE · Remove routing rule',
    description: 'Remove one explicit routing rule. Existing task decisions and outcome evidence remain immutable history.',
    inputSchema: objectSchema({ personalSpaceId: id, ruleId: id }, ['personalSpaceId', 'ruleId'])
  },
  {
    name: 'record_project_agent_task_outcome',
    title: 'WRITE · Record explicit routing outcome evidence',
    description: 'Record explicit user/test outcome evidence against a matching recorded execution. Use the task workKind and effective modelStrategy plus real referenceIds; a CLI session ID alone is not a recorded run. Terminal routing outcomes are already derived from valid task activity; do not submit them again. Never infer satisfaction or fabricate execution evidence to clear a validation error.',
    inputSchema: projectAgentTaskOutcomeInput
  },
  {
    name: 'list_project_agent_routing_learning',
    title: 'READ · View routing-learning evidence',
    description: 'List routing-learning evidence and flexible same-level tie-break weights with contribution, asOf, halfLife, and neutral/ignored status. Agent locked policy and explicit task/assignment/project/space priority always win; learning never overrides them or turns missing evidence into a preference.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: nullableStringSchema(),
      workKind: nullableStringSchema(),
      agentId: nullableStringSchema(),
      executorId: nullableStringSchema()
    }, ['personalSpaceId'])
  },
  {
    name: 'ignore_project_agent_routing_learning',
    title: 'WRITE · Ignore routing-learning evidence',
    description: 'Mark one routing-learning item ignored with an explicit reason; it remains auditable and cannot silently rewrite task history.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      agentId: id,
      evidenceId: id,
      idempotencyKey,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'agentId', 'evidenceId', 'idempotencyKey', 'reason'])
  },
  {
    name: 'reset_project_agent_routing_learning',
    title: 'WRITE · Reset routing-learning weights',
    description: 'Reset selected routing-learning evidence or scope through the Provider. Reset records remain auditable and do not change historical routing decisions.',
    inputSchema: objectSchema({
      personalSpaceId: id,
      personalProjectId: id,
      workKind: boundedString(128),
      agentId: id,
      executorId: id,
      modelStrategy: projectAgentModelStrategy,
      modelStrategyKey: nullableStringSchema(),
      idempotencyKey,
      resetAt: dateTime,
      reason: shortText
    }, ['personalSpaceId', 'personalProjectId', 'workKind', 'agentId', 'executorId', 'idempotencyKey', 'resetAt', 'reason'])
  }
];
