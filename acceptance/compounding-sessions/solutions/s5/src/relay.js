import { channel } from './channels/index.js';
import { ChannelError } from './errors.js';

export async function relay(message, { transports = {}, sleep } = {}) {
  const target = channel(message.channel);
  if (!target) throw new ChannelError('TW-RELAY-001', `unknown channel: ${message.channel}`);
  return target.send(message, { transport: transports[message.channel], sleep });
}
