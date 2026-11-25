import { isSystemPromptEntry } from '../system-prompt.js';

const TASK_NOTIFICATION = /^\s*<task-notification>\s*<task-id>([^<>\r\n]+)<\/task-id>([\s\S]*)<\/task-notification>\s*$/;
const CI_MONITOR_TAG = /<(\/?)ci-monitor-event>/g;

// Where a prompt turn came from (unresolved-turns.js): 'host_system' for a
// host system delivery, 'host_event' for a background notification, and
// 'person' for anything else. The host's own mark decides where the hook input
// carries one (isMeta or is_meta, true or false); only an input without it is
// read by its shape: a prompt that is exactly one host-notification envelope
// is a host event, whoever sent it. A known misreading: a person who pastes a
// whole envelope with no other text is taken as a host event, so that turn
// begins no task and receives no context. Any text around the envelope makes it a person's prompt again. Neither the hook input nor the
// transcript written before the hook proves that the host started such a
// turn, and a notification must not begin or switch a task, so host turns
// never enter.
export function claudeTurnOrigin(input) {
  if (isSystemPromptEntry(input)) return 'host_system';
  if (typeof input?.isMeta === 'boolean' || typeof input?.is_meta === 'boolean') return 'person';
  return taskNotificationEnvelope(input?.prompt) || ciMonitorEnvelope(input?.prompt) ? 'host_event' : 'person';
}

function taskNotificationEnvelope(prompt) {
  const match = typeof prompt === 'string' && TASK_NOTIFICATION.exec(prompt);
  return Boolean(match && match[1].trim() && !/<\/?task-notification>/.test(match[2]));
}

// One outer <ci-monitor-event>…</ci-monitor-event> with content; nested events
// are part of it, two envelopes side by side are not one. The desktop app's
// own text names the tag in prose, an opening tag that is never closed, so
// only a close before the end ends the envelope early (rec#15).
function ciMonitorEnvelope(prompt) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text.startsWith('<ci-monitor-event>') || !text.endsWith('</ci-monitor-event>')) return false;
  let depth = 0;
  for (const tag of text.matchAll(CI_MONITOR_TAG)) {
    depth += tag[1] ? -1 : 1;
    if (depth < 0 || (depth === 0 && tag.index + tag[0].length !== text.length)) return false;
  }
  return text.length > '<ci-monitor-event></ci-monitor-event>'.length
    && Boolean(text.slice('<ci-monitor-event>'.length, -'</ci-monitor-event>'.length).trim());
}
