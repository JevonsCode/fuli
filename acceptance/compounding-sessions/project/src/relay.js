import { channel } from './channels/index.js';

export async function relay(message, { transports = {}, sleep } = {}) {
  const target = channel(message.channel);
  return target.send(message, { transport: transports[message.channel], sleep });
}
