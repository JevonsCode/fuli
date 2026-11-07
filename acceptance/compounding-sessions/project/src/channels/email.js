import { ChannelError } from '../errors.js';

export const name = 'email';

export async function send(message, { transport }) {
  if (!String(message.to ?? '').includes('@')) throw new ChannelError('TW-EMAIL-001', `not an email address: ${message.to}`);
  const result = await transport({ kind: 'email', to: message.to, subject: message.subject ?? '', body: message.body ?? '' });
  if (result.status >= 400) throw new ChannelError('TW-EMAIL-002', `email provider answered ${result.status}`);
  return { id: result.id };
}
