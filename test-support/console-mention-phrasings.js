// The text the console's #FLA copy button and its tip card put on the
// clipboard (web/src/features/agent-profile/fla-mention.ts), rendered from the
// console's own messages as vue-i18n renders named values. Task entry tests
// paste it to prove the console only suggests what entry accepts.
import { clipboardText, conversationPhrasings, flaMention, mentionPhrasings } from '../web/src/features/agent-profile/fla-mention.ts';
import { agentProfileMessages } from '../web/src/i18n/messages/agent-profiles.ts';

export const CONSOLE_LOCALES = Object.keys(agentProfileMessages);

const translator = locale => {
  const template = agentProfileMessages[locale].mention;
  return (key, values) => template[key].replace(/\{(\w+)\}/gu, (_, field) => values[field]);
};

// { mention, continue, pair, recommend }: each exactly as copied.
export function consolePhrasings(locale, name, partner) {
  const translate = translator(locale);
  return Object.fromEntries([['mention', flaMention(name)],
    ...mentionPhrasings(name, partner, translate).map(item => [item.key, item.text])]
    .map(([key, text]) => [key, clipboardText(text)]));
}

// { discuss, pair, relay, continue }: the 圆桌 page's "how Agents start talking" examples, each exactly as copied.
export function consoleConversationPhrasings(locale, names) {
  return Object.fromEntries(conversationPhrasings(names, translator(locale)).map(item => [item.key, clipboardText(item.text)]));
}
