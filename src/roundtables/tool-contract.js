import { createHash } from 'node:crypto';

const text = (maxLength = 256) => ({ type: 'string', minLength: 1, maxLength });
const common = { roomId: text(), seatToken: text(512) };
const tool = (name, description, properties, required = []) => ({ name, description,
  inputSchema: { type: 'object', properties: { ...common, ...properties },
    required: ['roomId', ...required], additionalProperties: false } });

export const ROUNDTABLE_TOOL_DEFINITIONS = [
  tool('read_roundtable', 'Read only the shared brief, messages and tasks of your invited Roundtable. A seat invitation is required; it does not grant private Fuli memory.',
    { after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }),
  tool('join_roundtable', 'Join your own invited seat. This records a connected participant, not proof that a model executed.', {}),
  tool('claim_roundtable_turn', 'Claim only your assigned Roundtable turn. Null means wait. Do not perform work until a claim succeeds; respect deadline and scoped context.', {}),
  tool('submit_roundtable_turn', 'Submit one final response for the claimed turn. Echo the exact attempt/fence; use the same idempotency key for uncertain retries. Artifacts and verification remain reported evidence.', {
    turnId: text(), attemptId: text(), fence: { type: 'integer', minimum: 1 }, idempotencyKey: text(),
    body: text(16384), kind: { type: 'string', enum: ['proposal', 'question', 'review', 'handoff', 'result', 'dissent'] },
    status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
    blockedReason: { type: 'string', enum: ['waiting_auth', 'waiting_input'] },
    artifacts: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: true } },
    actual: { type: 'object', additionalProperties: true },
    verification: { type: 'object', additionalProperties: true },
    dissent: { type: 'array', maxItems: 16, items: text(1024) }
  }, ['turnId', 'attemptId', 'fence', 'idempotencyKey', 'body'])
];
export const ROUNDTABLE_TOOL_NAMES = ROUNDTABLE_TOOL_DEFINITIONS.map(({ name }) => name);

export async function callRoundtableTool(service, name, input, boundActor = null) {
  if (!service) throw new Error('Roundtable runtime unavailable');
  const actor = boundActor ?? service.authenticate({
    roomId: input.roomId, seatToken: input.seatToken,
    sourceApplication: input.sourceApplication ?? 'other',
    sourceSessionId: input.sourceSessionId ?? `capability-${createHash('sha256').update(input.seatToken ?? '').digest('hex').slice(0, 24)}`
  });
  // An actor is constructed by a transport, never accepted from client JSON.
  const { seatToken: _secret, sourceApplication: _source, sourceSessionId: _session, actor: _actor, ...safe } = input;
  const methods = { read_roundtable: 'read', join_roundtable: 'join',
    claim_roundtable_turn: 'claim', submit_roundtable_turn: 'submit' };
  const method = methods[name];
  if (!method) throw new TypeError('Unknown Roundtable tool');
  return service[method](safe, actor);
}
