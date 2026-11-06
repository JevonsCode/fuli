import { ChannelError } from '../errors.js';
import { withRetry } from '../retry.js';

export const name = 'email';

export async function send(message, { transport, sleep }) {
  if (!String(message.to ?? '').includes('@')) throw new ChannelError('TW-EMAIL-001', `not an email address: ${message.to}`);
  const payload = { kind: 'email', to: message.to, subject: message.subject ?? '', body: message.body ?? '' };
  const result = await withRetry(() => transport(payload), { sleep });
  if (result.status >= 400) throw new ChannelError('TW-EMAIL-002', `email provider answered ${result.status}`);
  return { id: result.id };
}
