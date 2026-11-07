// Writes the sample messages the specs read. spec/fixtures/ is generated and not committed.
import { mkdirSync, writeFileSync } from 'node:fs';

const messages = {
  email: { channel: 'email', to: 'ops@tidewater.example', subject: 'Tide alert', body: 'Level 3.2 m at 06:10' },
  sms: { channel: 'sms', to: '+15550100200', body: 'Tide alert: level 3.2 m at 06:10' },
  badEmail: { channel: 'email', to: 'ops.tidewater.example', subject: 'x', body: 'x' },
  badSms: { channel: 'sms', to: '5550100200', body: 'x' }
};
mkdirSync(new URL('../spec/fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('../spec/fixtures/messages.json', import.meta.url), `${JSON.stringify(messages, null, 2)}\n`);
console.log('wrote spec/fixtures/messages.json');
