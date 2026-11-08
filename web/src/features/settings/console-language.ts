import { z } from 'zod'
import { getJson, putJson } from '@/api/client'
import { shapeFor } from '@/api/response-shape'
import { currentLocale } from '@/i18n'
import { withoutRestartChanges } from '@/features/settings/settings-restart'
import type { SystemSettingsResult } from '@/types'

const settingsShape = shapeFor<SystemSettingsResult>(z.looseObject({
  configured: z.looseObject({ consoleLanguage: z.string().optional() }),
  active: z.looseObject({}),
}))

// Clients' /fla menu says project and role in the console's language
// (src/graphiti/fla-menu.js), which the browser keeps. Until the person picks
// one on the settings page, FULI's settings hold none: the console's own
// language goes there once, so the menu follows what the person already sees
// rather than this computer's. Saved like the naming style: read again,
// change only this field, never a restart setting. A failure changes nothing.
export async function rememberConsoleLanguage() {
  try {
    const current = await getJson('/api/system/settings', settingsShape)
    if (current.configured.consoleLanguage !== '') return
    await putJson('/api/system/settings', { ...withoutRestartChanges(current.configured, current.active),
      consoleLanguage: currentLocale() }, settingsShape)
  } catch {
    // The next console load tries again.
  }
}
