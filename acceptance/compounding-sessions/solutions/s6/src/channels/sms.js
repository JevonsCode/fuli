import { ChannelError } from '../errors.js';
import { withRetry } from '../retry.js';

export const name = 'sms';

export async function send(message, { transport, sleep }) {
  if (!/^\+\d{6,15}$/.test(String(message.to ?? ''))) throw new ChannelError('TW-SMS-001', `not an E.164 number: ${message.to}`);
  const payload = { kind: 'sms', to: message.to, text: String(message.body ?? '').slice(0, 160) };
  const result = await withRetry(() => transport(payload), { sleep });
  if (result.status >= 400) throw new ChannelError('TW-SMS-002', `sms provider answered ${result.status}`);
  return { id: result.id };
}
