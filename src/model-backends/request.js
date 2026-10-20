import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { MODEL_BACKEND_ROLES, OPERATION_PATTERN } from './config.js';
import { DECISIONS, DEFAULT_DECISIONS } from './decision-contract.js';

// Caller input of the model port. Invalid input is a programming error and
// throws TypeError; runtime conditions come back as classified results.
// Project or user content belongs in evidence, each item with its project,
// so the egress check sees it; instructions and options are operation text.

export const CONNECTION_CHECK = 'connection_check';

const id = z.string().trim().min(1).max(256);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
const isoTime = z.string().max(40).refine(value => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
  'must be an ISO date-time').transform(value => new Date(value).toISOString());

const outputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), options: z.array(z.object({ id: key, description: z.string().trim().min(1).max(500) }).strict())
    .min(2).max(255).refine(options => new Set(options.map(option => option.id)).size === options.length, 'option IDs must be unique') }).strict(),
  z.object({ type: z.literal('score'), levels: z.array(z.string().trim().min(1).max(500)).min(2).max(10) }).strict(),
  z.object({ type: z.literal('structured'), schema: z.looseObject({}) }).strict()
]);

const requestSchema = z.object({
  role: z.enum(MODEL_BACKEND_ROLES),
  operation: z.string().regex(OPERATION_PATTERN),
  requestId: id,
  sourceEventId: id.nullable().default(null),
  scope: z.object({ personalSpaceId: id, personalProjectId: id.nullable(), sessionRef: id.nullable() }).strict(),
  versions: z.object({ evidence: id, policy: id }).strict(),
  instructions: z.string().trim().min(1).max(4000),
  evidence: z.array(z.object({ id: key, personalProjectId: id.nullable(), text: z.string().trim().min(1).max(20_000) }).strict())
    .max(64).default([])
    .refine(items => new Set(items.map(item => item.id)).size === items.length, 'evidence IDs must be unique'),
  output: outputSchema,
  decisions: z.array(z.enum(DECISIONS)).min(1).max(DECISIONS.length).default([...DEFAULT_DECISIONS]),
  budget: z.object({ maxOutputTokens: z.number().int().positive(), timeoutMs: z.number().int().positive() })
    .partial().strict().default({})
}).strict();

const usageQuerySchema = z.object({
  role: z.enum(MODEL_BACKEND_ROLES).nullable().default(null),
  from: isoTime.nullable().default(null),
  to: isoTime.nullable().default(null)
}).strict().refine(query => !query.from || !query.to || query.from <= query.to, 'from must not be after to');

// role_work tool input. sourceApplication and sourceSessionId are set by the
// MCP process for its own client, never taken from the payload.
const sessionInput = { taskContextToken: id, sourceApplication: id.default('other'), sourceSessionId: id.optional() };
const tokens = z.number().int().min(0).max(100_000_000);
const claimSchema = z.object({ ...sessionInput, packageId: id.optional() }).strict();
const submitSchema = z.object({ ...sessionInput, packageId: id, leaseToken: id, answer: z.looseObject({}),
  usage: z.object({ inputTokens: tokens, outputTokens: tokens }).partial().strict().optional() }).strict();

export function parseDecisionRequest(input) {
  return parse(requestSchema, input, 'model decision request');
}

export function parseRoleWorkClaim(input) {
  return parse(claimSchema, input, 'role work claim');
}

export function parseRoleWorkSubmission(input) {
  return parse(submitSchema, input, 'role work submission');
}

export function parseUsageQuery(input = {}) {
  const present = Object.fromEntries(Object.entries(input ?? {}).filter(([, value]) => value !== undefined && value !== null && value !== ''));
  return parse(usageQuerySchema, present, 'model usage query');
}

// A fixed synthetic request: no project, no evidence, nothing from the user.
export function connectionCheckRequest(role) {
  return {
    role, operation: CONNECTION_CHECK, requestId: `${CONNECTION_CHECK}:${randomUUID()}`,
    scope: { personalSpaceId: 'connection-check', personalProjectId: null, sessionRef: null },
    versions: { evidence: 'none', policy: 'none' },
    instructions: 'This is a connection check. Choose the option ready.',
    output: { type: 'choice', options: [{ id: 'ready', description: 'The model can answer.' },
      { id: 'not_ready', description: 'Something prevents an answer.' }] }
  };
}

function parse(schema, input, label) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TypeError(`Invalid ${label}: ${result.error.issues.map(issue => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; ')}`);
  }
  return result.data;
}
