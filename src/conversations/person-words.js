// What of a turn's text the person wrote themself. Hosts deliver their own
// notes inside the user's turn as tagged blocks — <system-reminder>,
// <side-sessions-event>, <task-notification>, <cross-session-message>,
// <ci-monitor-event>, <pasted_content>, <environment_context> — often quoting
// another session's report; and a person may paste such a report as a quote
// ("> …"). None of that is the person stating anything, so learning from a
// turn (rec#88: stated rules, the reply's rules) reads only what is left once
// those blocks and quoted lines are set aside. Agent-agnostic: an envelope is
// any closed block whose tag name joins words with "-" or "_", the shape every
// host uses and ordinary markup (<b>, <div>) does not.
const ENVELOPE = /<([A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+)(?:\s[^<>]*)?>[\s\S]*?<\/\1\s*>/gu;
const STRAY_TAG = /<\/?[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+(?:\s[^<>]*)?>/gu;
const QUOTED_LINE = /^[ \t]*>.*$/gmu;

export function personWords(text) {
  if (typeof text !== 'string') return '';
  let rest = text;
  for (let previous = null; previous !== rest;) {
    previous = rest;
    rest = rest.replace(ENVELOPE, '\n');
  }
  return rest.replace(STRAY_TAG, '\n').replace(QUOTED_LINE, '')
    .replace(/[ \t]+$/gmu, '').replace(/\n{3,}/gu, '\n\n').trim();
}
