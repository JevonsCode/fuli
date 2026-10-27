import { getJson, postJson } from '@/api/client'

// The console's own update (src/system/console-update.js), started from the
// update notice. An npm installation runs the same update `fuli update --yes`
// runs; a Windows tray installation downloads the release's verified package
// and runs its own updater. It stops and restarts FULI, so the page asks for
// the outcome until the console answers.

export type ConsoleUpdateKind = 'npm' | 'windows-tray'
export type ConsoleUpdateStep = 'downloading' | 'verifying' | 'exitingTray' | 'installing'

// A FULI process that kept the update from switching versions.
export interface ConsoleUpdateBlocker {
  role: 'console' | 'database' | 'provider'
  pid: number
  createdFileTime: string
  executable: string | null
}

export interface ConsoleUpdateStatus {
  id: string
  status: 'updating' | 'updated' | 'unchanged' | 'failed'
  kind: ConsoleUpdateKind
  fromVersion: string
  targetVersion: string | null
  version: string | null
  step: ConsoleUpdateStep | null
  started: boolean | null
  error: string | null
  blockers: ConsoleUpdateBlocker[] | null
}

// stopProcesses: the blockers the person chose to stop, as the last failure named them.
export const startConsoleUpdate = (stopProcesses: string[] = []) =>
  postJson<ConsoleUpdateStatus>('/api/system/update', stopProcesses.length ? { stopProcesses } : {})
export const readConsoleUpdate = () => getJson<{ update: ConsoleUpdateStatus | null }>('/api/system/update')

export function updateFinished(status: ConsoleUpdateStatus | null, id: string): status is ConsoleUpdateStatus {
  return status?.id === id && status.status !== 'updating'
}

export const blockerKey = (blocker: ConsoleUpdateBlocker) => `${blocker.pid}:${blocker.createdFileTime}`
