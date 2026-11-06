import { ChannelError } from '../errors.js';
import { withRetry } from '../retry.js';

export const name = 'webhook';

export async function send(message, { transport, sleep }) {
  if (!/^https?:\/\//.test(String(message.url ?? ''))) throw new ChannelError('TW-WEBHOOK-001', `not a webhook URL: ${message.url}`);
  const payload = { kind: 'webhook', method: 'POST', url: message.url, body: message.body ?? {} };
  const result = await withRetry(() => transport(payload), { sleep, shouldRetry: (answer) => answer.status >= 400 });
  if (result.status >= 400) throw new ChannelError('TW-WEBHOOK-002', `webhook answered ${result.status}`);
  return { id: result.id };
}
