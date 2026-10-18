import { z } from 'zod';
import { PeerError } from '../agent-peer/protocol.js';
import { waitForChatChange } from './chat-wait.js';

const input = z.object({ after: z.number().int().nonnegative().default(0),
  timeoutSeconds: z.number().int().min(1).max(300).default(60) }).strict();
const output = z.object({ updates: z.array(z.object({ chatId: z.string().min(1).max(160),
  seq: z.number().int().nonnegative() }).strict()).max(100), nextAfter: z.number().int().nonnegative() }).strict();

export function parseChatUpdates(value) {
  const result = output.safeParse(value);
  if (!result.success) throw new PeerError('invalid_chat_response', 'Invalid chat notification response', 502);
  return result.data;
}

// Authenticated owner metadata only, filtered by current node membership on
// every read. The cursor is durable; it never carries an Agent task token.
export function waitForChatUpdates({ store, scope, owns, authorize, request, signal }) {
  const parsed = input.safeParse(request);
  if (!parsed.success) throw new PeerError('invalid_chat', 'Invalid chat notification cursor/deadline', 422);
  const { after, timeoutSeconds } = parsed.data;
  return waitForChatChange(() => {
    authorize();
    const changes = store.changes(scope, after);
    return { updates: changes.filter(item => store.members(item.chatId).some(owns))
      .map(({ chatId, seq }) => ({ chatId, seq })), nextAfter: changes.at(-1)?.cursor ?? after };
  }, { store, timeoutSeconds, signal, ready: page => page.nextAfter > after });
}
