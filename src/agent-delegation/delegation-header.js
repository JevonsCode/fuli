import { InvalidInputError } from '../app/application-error.js';

// The one header that marks a console request as an FLA's change for the
// person (rec#11 D-81): who made it, why, and the body field names it sent.
// run_delegated_action writes it; the console's delegation gate reads it. A
// request without it is the person's own and is not changed.
export const DELEGATION_HEADER = 'x-fuli-delegation';
// The operation record the console wrote for that request.
export const DELEGATION_OPERATION_HEADER = 'x-fuli-delegation-operation';

const TEXT_LIMIT = 256;
const REASON_LIMIT = 500;
const FIELD_LIMIT = 64;
const ACTOR_FIELDS = ['agentId', 'projectId', 'client', 'sessionId'];

export function encodeDelegation({ actor, reason, bodyFields }) {
  return encodeURIComponent(JSON.stringify({ actor, reason, bodyFields }));
}

export function decodeDelegation(value) {
  let call;
  try {
    call = JSON.parse(decodeURIComponent(String(value)));
  } catch {
    throw new InvalidInputError(`${DELEGATION_HEADER} must be the encoded call run_delegated_action sends`);
  }
  const actor = Object.fromEntries(ACTOR_FIELDS.map((field) => [field, optionalText(call?.actor?.[field], field)]));
  if (typeof call?.reason !== 'string' || !call.reason.trim() || call.reason.length > REASON_LIMIT) {
    throw new InvalidInputError(`reason must be 1 to ${REASON_LIMIT} characters`);
  }
  const bodyFields = Array.isArray(call.bodyFields) ? call.bodyFields : [];
  if (bodyFields.length > FIELD_LIMIT || !bodyFields.every((field) => typeof field === 'string' && field.length <= TEXT_LIMIT)) {
    throw new InvalidInputError(`bodyFields must be at most ${FIELD_LIMIT} field names`);
  }
  return { actor, reason: call.reason.trim(), bodyFields };
}

function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) {
    throw new InvalidInputError(`actor.${field} must be text of at most ${TEXT_LIMIT} characters`);
  }
  return value;
}
