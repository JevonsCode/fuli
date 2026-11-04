import { InvalidInputError } from '../app/application-error.js';
import { PERSON_WORDS_MAX, PERSON_WORDS_MIN } from './person-words.js';

// The one header that marks a console request as an FLA's change for the
// person (rec#11 D-81): who made it, why, and the body field names it sent;
// for a decision it relays (rec#80), the person's words and the message they
// were found in. run_delegated_action writes it; the console's delegation
// gate reads it. A request without it is the person's own and is not changed.
export const DELEGATION_HEADER = 'x-fuli-delegation';
// The operation record the console wrote for that request.
export const DELEGATION_OPERATION_HEADER = 'x-fuli-delegation-operation';

const TEXT_LIMIT = 256;
const REASON_LIMIT = 500;
const FIELD_LIMIT = 64;
const ACTOR_FIELDS = ['agentId', 'projectId', 'client', 'sessionId'];
const MESSAGE_FIELDS = ['source', 'taskId', 'conversationId', 'at'];

export function encodeDelegation({ actor, reason, bodyFields, relayed = null }) {
  return encodeURIComponent(JSON.stringify({ actor, reason, bodyFields, ...(relayed ? { relayed } : {}) }));
}

export function decodeDelegation(value) {
  let call;
  try {
    call = JSON.parse(decodeURIComponent(String(value)));
  } catch {
    throw new InvalidInputError(`${DELEGATION_HEADER} must be the encoded call run_delegated_action sends`);
  }
  const actor = Object.fromEntries(ACTOR_FIELDS.map((field) => [field, optionalText(call?.actor?.[field], `actor.${field}`)]));
  if (typeof call?.reason !== 'string' || !call.reason.trim() || call.reason.length > REASON_LIMIT) {
    throw new InvalidInputError(`reason must be 1 to ${REASON_LIMIT} characters`);
  }
  const bodyFields = Array.isArray(call.bodyFields) ? call.bodyFields : [];
  if (bodyFields.length > FIELD_LIMIT || !bodyFields.every((field) => typeof field === 'string' && field.length <= TEXT_LIMIT)) {
    throw new InvalidInputError(`bodyFields must be at most ${FIELD_LIMIT} field names`);
  }
  return { actor, reason: call.reason.trim(), bodyFields, relayed: relayedWords(call.relayed) };
}

// The relayed decision of a console request, or null for the person's own
// request and any other delegated one. The delegation gate has already
// checked the header of every request that reaches a handler.
export function relayedDecision(request) {
  const header = request.headers[DELEGATION_HEADER];
  if (header === undefined) return null;
  const { actor, relayed } = decodeDelegation(header);
  return relayed ? { relayedBy: actor.agentId, personWords: relayed.words, messageRef: relayed.messageRef } : null;
}

function relayedWords(relayed) {
  if (relayed === undefined || relayed === null) return null;
  const words = relayed.words;
  if (typeof words !== 'string' || words.trim().length < PERSON_WORDS_MIN || words.length > PERSON_WORDS_MAX) {
    throw new InvalidInputError(`relayed.words must be ${PERSON_WORDS_MIN} to ${PERSON_WORDS_MAX} characters`);
  }
  const messageRef = Object.fromEntries(MESSAGE_FIELDS.map((field) =>
    [field, optionalText(relayed.messageRef?.[field], `relayed.messageRef.${field}`)]));
  return { words: words.trim(), messageRef };
}

function optionalText(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value.length > TEXT_LIMIT) {
    throw new InvalidInputError(`${field} must be text of at most ${TEXT_LIMIT} characters`);
  }
  return value;
}
