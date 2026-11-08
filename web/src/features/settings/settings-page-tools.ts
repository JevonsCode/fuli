import { z } from 'zod'

import { shapeFor } from '@/api/response-shape'
import { definePageTool } from '@/features/webmcp/page-tool'
import type { RuntimeSettings, SystemSettingsResult } from '@/types'

import { withoutRestartChanges } from './settings-restart'

// The settings page's tools for the browser's AI agent (WebMCP). Saving runs
// through the delegation gate (settings permission), like the page's own
// automatic save; ports, LAN access and the graph runtime need a restart and
// stay the person's 应用并重启.

const SETTINGS_SHAPE = shapeFor<SystemSettingsResult>(z.looseObject({ restartRequired: z.boolean(),
  configured: z.looseObject({ notifications: z.looseObject({}), ports: z.looseObject({}) }), active: z.looseObject({ ports: z.looseObject({}) }) }))

const CHANGES = z.object({
  topicPromotion: z.enum(['auto', 'ask']).optional(),
  flaSlashMenu: z.boolean().optional().describe('Whether Agent clients list the FLAs under /fla.'),
  agentNamingStyle: z.string().max(500).optional(),
  resourceRefreshSeconds: z.union([z.literal(5), z.literal(10), z.literal(30), z.literal(60)]).optional(),
  updateChannel: z.enum(['stable', 'beta']).optional(),
  needsPersonUrl: z.string().max(2000).optional().describe('Where FULI sends a notification when an Agent needs the person; empty turns it off.'),
}).refine(changes => Object.keys(changes).length > 0, 'Name at least one setting')

const visible = (settings: RuntimeSettings) => ({
  topicPromotion: settings.topicPromotion, flaSlashMenu: settings.flaSlashMenu, agentNamingStyle: settings.agentNamingStyle,
  resourceRefreshSeconds: settings.resourceRefreshSeconds, updateChannel: settings.updateChannel,
  needsPersonUrl: settings.notifications.needsPersonUrl, lanAccess: settings.lanAccess, ports: settings.ports,
})

export function settingsPageTools(page: { saved: (result: SystemSettingsResult) => void }) {
  return [
    definePageTool({
      name: 'fuli_read_settings',
      title: 'Read FULI settings',
      description: 'FULI\'s runtime settings as saved and as running now, and whether a restart is pending.',
      input: z.object({}),
      routes: ['GET /api/system/settings'],
      readOnly: true,
      async run(_input, context) {
        const result = await context.read('/api/system/settings', SETTINGS_SHAPE)
        return { configured: visible(result.configured), restartRequired: result.restartRequired }
      },
    }),
    definePageTool({
      name: 'fuli_update_settings',
      title: 'Change FULI settings',
      description: 'Change settings that apply without a restart: topicPromotion, flaSlashMenu, agentNamingStyle, resourceRefreshSeconds, updateChannel, needsPersonUrl. Other settings stay as they are.',
      input: CHANGES,
      routes: ['GET /api/system/settings', 'PUT /api/system/settings'],
      async run(input, context) {
        const current = await context.read('/api/system/settings', SETTINGS_SHAPE)
        const { needsPersonUrl, ...rest } = input
        const next: RuntimeSettings = { ...withoutRestartChanges(current.configured, current.active), ...rest,
          ...(needsPersonUrl !== undefined ? { notifications: { ...current.configured.notifications, needsPersonUrl } } : {}) }
        const result = await context.change({ route: 'PUT /api/system/settings', body: { ...next }, shape: SETTINGS_SHAPE })
        page.saved(result)
        return { configured: visible(result.configured), restartRequired: result.restartRequired }
      },
    }),
  ]
}
