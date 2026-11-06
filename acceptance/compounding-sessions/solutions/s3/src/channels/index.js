import * as email from './email.js';
import * as sms from './sms.js';
import * as webhook from './webhook.js';

export const channels = { email, sms, webhook };

export function channel(name) {
  return channels[name];
}
