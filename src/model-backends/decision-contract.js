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
// The most rule codes one attempt keeps in the usage ledger.
const MAX_CODES = 16;
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
  // A batch (output.items) is checked item by item: its array alone is
  // left open here, so one bad item does not void the rest.
  const batch = output.items ? batchCheck(payloadSchema, output.items) : null;
  const reply = answerSchema(batch ? withOpenItems(modelSchema, output.items.field) : modelSchema);
  const payload = answerSchema(payloadSchema);
  return {
    // The whole schema each reply is checked against, and the shape of it a provider's structured output takes.
    schema: modelSchema,
    providerSchema: providerSchema(modelSchema),
    // { ok, value } or { ok: false, issues, codes }: issues say what is wrong
    // for the model's repair, codes name only the rule (path without
    // positions, and the check: "payload.decisions[].doubt:invalid_value")
    // for the usage ledger, never a value. A batch some of whose items passed
    // also carries partial: { value with those items, rejected: [{ key, issues }] }.
    validateReply(text) {
      let value;
      try {
        value = parseModelJson(text);
      } catch {
        return { ok: false, issues: ['the reply is not a single JSON object'], codes: ['reply:not_json'] };
      }
      const checked = checkedValue(reply, value);
      if (!checked.ok) return { ...checked, offSchema: true };
      if (new Set(checked.value.evidenceIds).size !== checked.value.evidenceIds.length) {
        return { ok: false, issues: ['evidenceIds: each ID may appear once'], codes: ['evidenceIds:duplicate'] };
      }
      return batch ? batch(checked.value) : checked;
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

// How an answer is read: a field the schema does not list is dropped, never
// refused (a model adding one changes nothing FULI uses); every listed field
// keeps its checks.
const answerSchema = schema => jsonSchemaToZod(schema, { unknownKeys: 'strip' });

function withOpenItems(modelSchema, field) {
  const payload = modelSchema.properties.payload;
  return { ...modelSchema, properties: { ...modelSchema.properties,
    payload: { ...payload, properties: { ...payload.properties, [field]: { type: 'array', items: { type: 'object' } } } } } };
}

// output.items { field, key }: payload[field] holds one object per key, and
// the item schema's key property is the enum of keys asked for. Each key is
// answered by exactly one item that passes the item schema, or it is
// rejected with why; an item for a key not asked for fails the reply but
// costs no other item. Item issues are named by key, never by position.
function batchCheck(payloadSchema, { field, key }) {
  const itemSchema = payloadSchema.properties?.[field]?.items;
  const keys = itemSchema?.properties?.[key]?.enum;
  if (!Array.isArray(keys)) throw new TypeError(`output.items: payload.${field} must hold objects whose ${key} is an enum`);
  const item = answerSchema(itemSchema);
  const at = ['payload', field, 0];
  return value => {
    const given = value.payload[field];
    const codes = new Set();
    const accepted = [];
    const rejected = [];
    // As for a whole reply: an item outside the schema says a structured-output endpoint ignored it.
    let offSchema = false;
    for (const entry of given.filter(entry => !keys.includes(entry?.[key]))) {
      offSchema = true;
      for (const issue of item.safeParse(entry).error?.issues ?? []) codes.add(issueCode([...at, ...issue.path], issue.code));
    }
    for (const asked of keys) {
      const answers = given.filter(entry => entry?.[key] === asked);
      if (answers.length !== 1) {
        codes.add(issueCode([...at, ...(answers.length ? [key] : [])], answers.length ? 'duplicate' : 'missing'));
        rejected.push({ key: asked, issues: [answers.length ? `${key} appears more than once` : 'no item answers it'] });
        continue;
      }
      const checked = item.safeParse(answers[0]);
      if (checked.success) {
        accepted.push(checked.data);
        continue;
      }
      offSchema = true;
      for (const issue of checked.error.issues) codes.add(issueCode([...at, ...issue.path], issue.code));
      rejected.push({ key: asked, issues: issueTexts(checked.error.issues) });
    }
    const partial = { ...value, payload: { ...value.payload, [field]: accepted } };
    if (!codes.size) return { ok: true, value: partial };
    return { ok: false, offSchema, codes: [...codes].slice(0, MAX_CODES), partial: { value: partial, rejected },
      issues: rejected.length ? rejected.slice(0, MAX_ISSUES).map(({ key: asked, issues }) => `${field} ${key} ${asked}: ${issues.join('; ')}`)
        : [`${field}: answer only the ${key} values asked for`] };
  };
}

// The host's envelope around a validated answer, whoever gave it: the model
// port or the current session completing a work package. rejectedItems: the
// keys of a batch the answer left without a usable item, with why; the
// payload holds only the items that passed.
export function decisionEnvelope(request, value, rejectedItems = []) {
  return {
    role: request.role, operation: request.operation, requestId: request.requestId, sourceEventId: request.sourceEventId,
    scope: request.scope,
    evidence: { refs: value.evidenceIds, evidenceVersion: request.versions.evidence, policyVersion: request.versions.policy },
    decision: value.decision, payload: value.payload, reason: value.reason, uncertainty: value.uncertainty,
    ...(rejectedItems.length ? { rejectedItems } : {}),
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
  return { ok: false, issues: issueTexts(result.error.issues),
    codes: [...new Set(result.error.issues.map(issue => issueCode(issue.path, issue.code)))].slice(0, MAX_CODES) };
}

const issueTexts = issues => issues.slice(0, MAX_ISSUES).map(issue => `${issue.path.join('.') || 'reply'}: ${issue.message}`);

// The rule an issue broke, without the value or the position it was at.
function issueCode(path, code) {
  const where = path.map(part => (typeof part === 'number' ? '[]' : `.${part}`)).join('').replace(/^\./, '');
  return `${where || 'reply'}:${code}`;
}
