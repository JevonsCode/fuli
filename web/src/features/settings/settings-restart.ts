import type { RuntimePorts, RuntimeSettings } from '@/types'

// Ports, LAN access and the graph runtime only take effect when FULI restarts
// (src/system/system-service.js settingsResult). They are the settings page's
// risky changes: the console restarts and may move to another address, so they
// wait for the person's 应用并重启 while everything else saves itself.
export type RestartField = 'ports' | 'lanAccess' | 'graphRuntimeMode'

// The ports the page lets the person change.
export const PERSONAL_PORT_KEYS: ReadonlyArray<keyof RuntimePorts> = [
  'console',
  'personalProvider',
  'personalNeo4jHttp',
  'personalNeo4jBolt',
]

// The settings safe to save at once: the person's form with every restart
// setting kept as FULI runs now, so saving it never restarts anything.
export function withoutRestartChanges(form: RuntimeSettings, active: RuntimeSettings): RuntimeSettings {
  return { ...form, ports: { ...active.ports }, lanAccess: active.lanAccess, graphRuntimeMode: active.graphRuntimeMode }
}

// Which restart settings the form changes from what FULI runs now.
export function pendingRestartFields(form: RuntimeSettings, active: RuntimeSettings): Set<RestartField> {
  const pending = new Set<RestartField>()
  if (PERSONAL_PORT_KEYS.some(key => form.ports[key] !== active.ports[key])) pending.add('ports')
  if (form.lanAccess !== active.lanAccess) pending.add('lanAccess')
  if (form.graphRuntimeMode !== active.graphRuntimeMode) pending.add('graphRuntimeMode')
  return pending
}
