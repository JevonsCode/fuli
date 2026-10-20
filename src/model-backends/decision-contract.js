import {
  arraySchema, boundedString, enumSchema, numberSchema, objectSchema
} from '../agent-tools/schema.js';
import { jsonSchemaToZod } from '../mcp/tool-schema.js';
import { parseModelJson } from '../text/model-json.js';

// rec#8 compact decision contract, model side. A model returns only the
// decision, payload, a short reason, the IDs of supplied evidence it relied
// on and what remains uncertain. The host fills scope, versions and the
// execution receipt; a model can never report permission or execution.

export const DECISIONS = Object.freeze(['propose', 'apply_authorized', 'ask_user', 'defer', 'no_change']);
export const DEFAULT_DECISIONS = Object.freeze(['propose', 'ask_user', 'defer', 'no_change']);

const REASON_MAX = 240;
const MAX_EVIDENCE_REFS = 16;
const MAX_ISSUES = 3;
// Providers differ in which JSON Schema constraints they accept, so they get
// the shape only; the full schema is enforced here after every reply.
const PROVIDER_SCHEMA_KEYS = new Set(['type', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'description']);

export function decisionContract({ output, decisions, evidence }) {
  const payloadSchema = payloadJsonSchema(output);
  const evidenceIds = evidence.map(item => item.id);
  const modelSchema = objectSchema({
    decision: enumSchema(decisions),
    payload: payloadSchema,
    reason: boundedString(REASON_MAX),
    evidenceIds: evidenceIds.length
      ? arraySchema(enumSchema(evidenceIds), { maxItems: Math.min(MAX_EVIDENCE_REFS, evidenceIds.length) })
      : arraySchema(boundedString(1), { maxItems: 0 }),
    uncertainty: { type: ['string', 'null'], maxLength: REASON_MAX }
  }, ['decision', 'payload', 'reason', 'evidenceIds', 'uncertainty']);
  const reply = jsonSchemaToZod(modelSchema);
  const payload = jsonSchemaToZod(payloadSchema);
  return {
    providerSchema: providerSchema(modelSchema),
    validateReply(text) {
      let value;
      try {
        value = parseModelJson(text);
      } catch {
        return { ok: false, issues: ['the reply is not a single JSON object'] };
      }
      const checked = checkedValue(reply, value);
      if (checked.ok && new Set(checked.value.evidenceIds).size !== checked.value.evidenceIds.length) {
        return { ok: false, issues: ['evidenceIds: each ID may appear once'] };
      }
      return checked;
    },
    // A typed backend answers only the payload; it cites no evidence.
    validatePayload(value) {
      const checked = checkedValue(payload, value);
      return checked.ok
        ? { ok: true, value: { decision: 'propose', payload: checked.value, reason: null, evidenceIds: [], uncertainty: null } }
        : checked;
    }
  };
}

// The host's envelope around a validated answer, whoever gave it: the model
// port or the current session completing a work package.
export function decisionEnvelope(request, value) {
  return {
    role: request.role, operation: request.operation, requestId: request.requestId, sourceEventId: request.sourceEventId,
    scope: request.scope,
    evidence: { refs: value.evidenceIds, evidenceVersion: request.versions.evidence, policyVersion: request.versions.policy },
    decision: value.decision, payload: value.payload, reason: value.reason, uncertainty: value.uncertainty,
    execution: { status: 'pending' }
  };
}

function payloadJsonSchema(output) {
  if (output.type === 'choice') {
    return objectSchema({ choice: enumSchema(output.options.map(option => option.id)) }, ['choice']);
  }
  if (output.type === 'score') {
    return objectSchema({ score: numberSchema({ minimum: 0, maximum: output.levels.length - 1 }) }, ['score']);
  }
  assertStrictSchema(output.schema, 'payload');
  jsonSchemaToZod(output.schema);
  return output.schema;
}

// Strict structured outputs need every object closed and every property
// required; an optional value is expressed as a ["type", "null"] union.
function assertStrictSchema(schema, path) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new TypeError(`Structured output schema at ${path} must be an object`);
  }
  if (schema.type === 'object' || (Array.isArray(schema.type) && schema.type.includes('object'))) {
    const properties = Object.keys(schema.properties ?? {});
    const required = new Set(schema.required ?? []);
    if (schema.additionalProperties !== false || properties.some(name => !required.has(name))) {
      throw new TypeError(`Structured output schema at ${path} must set additionalProperties false and list every property as required; use a ["type", "null"] union for optional values`);
    }
    for (const name of properties) assertStrictSchema(schema.properties[name], `${path}.${name}`);
  }
  if (schema.items) assertStrictSchema(schema.items, `${path}[]`);
}

function providerSchema(schema) {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => PROVIDER_SCHEMA_KEYS.has(key)).map(([key, value]) => {
    if (key === 'properties') {
      return [key, Object.fromEntries(Object.entries(value).map(([name, property]) => [name, providerSchema(property)]))];
    }
    return [key, key === 'items' ? providerSchema(value) : value];
  }));
}

function checkedValue(validator, value) {
  const result = validator.safeParse(value);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, issues: result.error.issues.slice(0, MAX_ISSUES)
    .map(issue => `${issue.path.join('.') || 'reply'}: ${issue.message}`) };
}
