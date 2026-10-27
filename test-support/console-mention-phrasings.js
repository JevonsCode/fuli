// The text the console's #FLA copy button and its tip card put on the
// clipboard (web/src/features/agent-profile/fla-mention.ts), rendered from the
// console's own messages as vue-i18n renders named values. Task entry tests
// paste it to prove the console only suggests what entry accepts.
import { clipboardText, flaMention, mentionPhrasings } from '../web/src/features/agent-profile/fla-mention.ts';
import { agentProfileMessages } from '../web/src/i18n/messages/agent-profiles.ts';

export const CONSOLE_LOCALES = Object.keys(agentProfileMessages);

// { mention, continue, pair, recommend }: each exactly as copied.
export function consolePhrasings(locale, name, partner) {
  const template = agentProfileMessages[locale].mention;
  const translate = (key, values) => template[key].replace(/\{(\w+)\}/gu, (_, field) => values[field]);
  return Object.fromEntries([['mention', flaMention(name)],
    ...mentionPhrasings(name, partner, translate).map(item => [item.key, item.text])]
    .map(([key, text]) => [key, clipboardText(text)]));
}
