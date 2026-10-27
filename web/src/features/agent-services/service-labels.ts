import type { ServiceLiveState, ServiceLogEntry } from './agent-services'

/** The badge tone of a live state: running is success, an unconfirmed one a warning. */
export function liveStateTone(state: ServiceLiveState) {
  return ({ running: 'success', stopped: 'secondary', unknown: 'warning' } as const)[state]
}

/**
 * One line of what a log entry recorded (who, which PID, why), without the
 * process output, which the log shows as its own block.
 */
export function logDetailText(entry: ServiceLogEntry): string {
  if (!entry.detail) return ''
  return Object.entries(entry.detail)
    .filter(([key, value]) => key !== 'text' && value !== null && value !== undefined && !(Array.isArray(value) && !value.length))
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ')
}

/** The process output an entry kept, if any. */
export function logOutput(entry: ServiceLogEntry): string | null {
  const text = entry.detail?.text
  return typeof text === 'string' && text ? text : null
}
