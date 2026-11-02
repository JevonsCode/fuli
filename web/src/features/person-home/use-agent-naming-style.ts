import { ref } from 'vue'
import { z } from 'zod'
import { getJson, putJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import { withoutRestartChanges } from '@/features/settings/settings-restart'
import { useSettingsAutoSave } from '@/features/settings/settings-autosave'
import type { SystemSettingsResult } from '@/types'

// The fields this page relies on; the rest of the settings pass through as they are.
const settingsShape = shapeFor<SystemSettingsResult>(z.looseObject({
  configured: z.looseObject({ agentNamingStyle: z.string() }),
  active: z.looseObject({}),
}))

// The FLA naming preference (agentNamingStyle in the device settings), edited
// on the person's home page and saved like Settings: after a pause in typing.
// Each save reads the settings again and changes only the style, so nothing
// else the settings page saved meanwhile is put back, and no restart setting
// is ever applied from here.
export function useAgentNamingStyle() {
  const style = ref('')
  const loaded = ref(false)
  const failed = ref(false)
  const autoSave = useSettingsAutoSave({
    read: () => style.value,
    save: async (agentNamingStyle) => {
      const current = await getJson('/api/system/settings', settingsShape)
      await putJson('/api/system/settings', { ...withoutRestartChanges(current.configured, current.active), agentNamingStyle }, settingsShape)
    },
    ready: () => loaded.value,
  })

  async function load() {
    failed.value = false
    try {
      const settings = await getJson('/api/system/settings', settingsShape)
      style.value = settings.configured.agentNamingStyle
      autoSave.remember(style.value)
      loaded.value = true
    } catch {
      failed.value = true
    }
  }

  return { style, loaded, failed, load, autoSave, changed: () => autoSave.changed('text') }
}
