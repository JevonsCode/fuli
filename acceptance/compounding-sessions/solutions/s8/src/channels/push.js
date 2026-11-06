import { ChannelError } from '../errors.js';
import { withRetry } from '../retry.js';

export const name = 'push';

// The push provider's sandbox; every request carries the key header.
const SANDBOX = 'https://sandbox.tidepush.example/v2';

export async function send(message, { transport, sleep }) {
  if (!message.to) throw new ChannelError('TW-PUSH-001', 'push message has no target device');
  const payload = { kind: 'push', method: 'POST', url: `${SANDBOX}/messages`,
    headers: { 'X-Tide-Key': process.env.TIDE_PUSH_KEY ?? '' }, body: { to: message.to, body: message.body ?? '' } };
  const result = await withRetry(() => transport(payload), { sleep });
  if (result.status >= 400) throw new ChannelError('TW-PUSH-002', `push provider answered ${result.status}`);
  return { id: result.id };
}
