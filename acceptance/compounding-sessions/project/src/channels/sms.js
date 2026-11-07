import { ChannelError } from '../errors.js';

export const name = 'sms';

export async function send(message, { transport }) {
  if (!/^\+\d{6,15}$/.test(String(message.to ?? ''))) throw new ChannelError('TW-SMS-001', `not an E.164 number: ${message.to}`);
  const result = await transport({ kind: 'sms', to: message.to, text: String(message.body ?? '').slice(0, 160) });
  if (result.status >= 400) throw new ChannelError('TW-SMS-002', `sms provider answered ${result.status}`);
  return { id: result.id };
}
