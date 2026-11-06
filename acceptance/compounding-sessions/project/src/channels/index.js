import * as email from './email.js';
import * as sms from './sms.js';

export const channels = { email, sms };

export function channel(name) {
  return channels[name];
}
