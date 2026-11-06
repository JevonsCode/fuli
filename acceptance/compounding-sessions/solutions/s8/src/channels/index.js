import * as email from './email.js';
import * as push from './push.js';
import * as sms from './sms.js';
import * as webhook from './webhook.js';

export const channels = { email, push, sms, webhook };

export function channel(name) {
  return channels[name];
}
