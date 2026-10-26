import { getJson, postJson } from '@/api/client'

// The console's own update (src/system/console-update.js): the same update
// `fuli update --yes` runs, started from the update notice. It stops and
// restarts FULI, so the page asks for the outcome until the console answers.

export interface ConsoleUpdateStatus {
  id: string
  status: 'updating' | 'updated' | 'unchanged' | 'failed'
  fromVersion: string
  version: string | null
  started: boolean | null
  error: string | null
}

export const startConsoleUpdate = () => postJson<ConsoleUpdateStatus>('/api/system/update', {})
export const readConsoleUpdate = () => getJson<{ update: ConsoleUpdateStatus | null }>('/api/system/update')

export function updateFinished(status: ConsoleUpdateStatus | null, id: string): status is ConsoleUpdateStatus {
  return status?.id === id && status.status !== 'updating'
}
