import { z } from 'zod';
import { PeerError } from '../agent-peer/protocol.js';

const text = max => z.string().trim().min(1).max(max);
const address = text(300);
const body = z.string().min(1).max(16_000).refine(value => value.trim().length > 0, 'Message body must not be blank');
const page = { after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) };
export const CHAT_LIMITS = Object.freeze({ members: 32, readBytes: 96 * 1024 });
const input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), requestId: text(128), kind: z.enum(['direct', 'group']),
    title: text(160).optional(), members: z.array(address).min(1).max(CHAT_LIMITS.members - 1) }).strict(),
  z.object({ action: z.literal('list'), limit: page.limit, afterChat: text(160).optional() }).strict(),
  z.object({ action: z.literal('read'), chatId: text(160), ...page }).strict(),
  z.object({ action: z.literal('wait'), chatId: text(160), ...page,
    timeoutSeconds: z.number().int().min(1).max(300).default(60) }).strict(),
  z.object({ action: z.literal('send'), chatId: text(160), requestId: text(128), body }).strict(),
  z.object({ action: z.literal('members'), chatId: text(160), expectedRevision: z.number().int().positive(),
    add: z.array(address).max(CHAT_LIMITS.members).default([]), remove: z.array(address).max(CHAT_LIMITS.members).default([]),
    owner: address.optional() }).strict()
]);
export function parseChatRequest(value) {
  const result = input.safeParse(value);
  if (!result.success) throw new PeerError('invalid_chat', result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), 422);
  return result.data;
}

const member = z.object({ address, agentId: text(128), name: text(160), node: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  joinedSeq: z.number().int().nonnegative() });
const room = z.object({ chatId: text(160), kind: z.enum(['direct', 'group']), title: text(160), owner: address,
  revision: z.number().int().positive(), members: z.array(member).max(CHAT_LIMITS.members), transport: z.enum(['local', 'peer']),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), left: z.boolean().optional() }).strict();
const message = z.object({ messageId: text(128), seq: z.number().int().positive(), from: address, body, createdAt: z.string().datetime() }).strict();
// A person's answer to the waiting Agent's own attention request (local inbox).
const attentionReply = z.object({ requestId: text(128), revision: z.number().int().nonnegative(),
  kind: text(32), choice: z.string().nullable(), note: z.string().nullable(), repliedAt: text(64), summary: text(8_500) }).strict();
const result = z.union([
  room.extend({ messages: z.array(message).max(100), nextAfter: z.number().int().nonnegative(), hasMore: z.boolean(),
    attentionReplies: z.array(attentionReply).max(5).optional() }),
  room, message,
  z.object({ chats: z.array(room).max(200), remoteUnavailable: text(160).optional(),
    hasMore: z.boolean().optional(), nextChat: text(160).nullable().optional(),
    remotePage: z.object({ hasMore: z.boolean(), nextChat: text(160).nullable() }).optional() }).strict()
]);
// The paired coordinator is a transport boundary, never an arbitrary MCP payload.
export function parseChatResult(value) {
  const parsed = result.safeParse(value);
  if (!parsed.success) throw new PeerError('invalid_chat_response', 'The chat response does not match the communication contract', 502);
  return parsed.data;
}
