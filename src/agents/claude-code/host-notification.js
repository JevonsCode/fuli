import { isSystemPromptEntry } from '../system-prompt.js';

const TASK_NOTIFICATION = /^\s*<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>([\s\S]*)<\/task-notification>\s*$/;
const CI_MONITOR_TAG = /<(\/?)ci-monitor-event>/g;

// Turns whose task transition cannot be proven (rec#15), or null for a prompt
// that enters as a new task: 'system' for a host system delivery (isMeta), whose
// task is still unknown, and 'envelope' for a prompt that is exactly one
// host-notification envelope, whoever sent it. Neither the hook input nor the
// transcript written before the hook proves that the host started such a turn,
// and a notification must not begin or switch a task. These turns re-read the
// current task in place instead of entering; a person who pastes an envelope
// gets that refresh too. Any text around the envelope makes it a prompt again.
export function inPlaceRefreshBasis(input) {
  if (isSystemPromptEntry(input)) return 'system';
  return taskNotificationEnvelope(input?.prompt) || ciMonitorEnvelope(input?.prompt) ? 'envelope' : null;
}

function taskNotificationEnvelope(prompt) {
  const match = typeof prompt === 'string' && TASK_NOTIFICATION.exec(prompt);
  return Boolean(match && match[1].trim() && !/<\/?task-notification>/.test(match[2]));
}

// One outer <ci-monitor-event>…</ci-monitor-event> with content; nested events
// are part of it, two envelopes side by side are not one.
function ciMonitorEnvelope(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text.startsWith('<ci-monitor-event>') || !text.endsWith('</ci-monitor-event>')) return false;
  let depth = 0;
  for (const tag of text.matchAll(CI_MONITOR_TAG)) {
    depth += tag[1] ? -1 : 1;
    if (depth < 0 || (depth === 0 && tag.index + tag[0].length !== text.length)) return false;
  }
  return depth === 0 && text.length > '<ci-monitor-event></ci-monitor-event>'.length
    && Boolean(text.slice('<ci-monitor-event>'.length, -'</ci-monitor-event>'.length).trim());
}
