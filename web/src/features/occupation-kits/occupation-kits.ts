import { z } from 'zod'
import { getJson, putJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// Occupation plugins (docs/occupation-plugins.md): each occupation's starter
// kit, curated from open-source collections with their license. The
// occupations page shows where each kit came from; an FLA's page shows which
// recommended Skills and MCP servers the person enabled for it.
const referenceSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  license: z.string(),
  summary: z.string(),
})
const pluginSchema = z.looseObject({
  id: z.string(),
  version: z.string(),
  occupations: z.array(z.string()),
  role: z.looseObject({ name: z.string(), source: z.string(), url: z.string() }),
  checklistCount: z.number(),
  acceptanceCount: z.number(),
  skills: z.array(referenceSchema),
  mcpServers: z.array(referenceSchema),
})
const sourceSchema = z.looseObject({
  id: z.string(),
  repository: z.string(),
  commit: z.string(),
  license: z.string(),
  url: z.string(),
})
const listSchema = z.looseObject({
  manifestVersion: z.number(),
  autoUpdate: z.boolean(),
  sources: z.array(sourceSchema),
  plugins: z.array(pluginSchema),
})
const kitReference = referenceSchema.extend({ enabled: z.boolean().nullable() })
const quotedSchema = z.looseObject({
  items: z.array(z.string()),
  from: z.looseObject({ source: z.string(), url: z.string(), license: z.string() }),
})
const kitSchema = z.looseObject({
  occupation: z.string(),
  plugin: z.looseObject({ id: z.string(), version: z.string(), role: z.looseObject({ name: z.string(), url: z.string() }) }).nullable(),
  checklist: quotedSchema.optional(),
  acceptance: quotedSchema.optional(),
  skills: z.array(kitReference).optional(),
  mcpServers: z.array(kitReference).optional(),
  choice: z.looseObject({ pluginVersion: z.string(), at: z.string(), outdated: z.boolean() }).nullable().optional(),
})

export type OccupationPlugin = z.infer<typeof pluginSchema>
export type OccupationPluginList = z.infer<typeof listSchema>
export type OccupationKit = z.infer<typeof kitSchema>
export type KitReference = z.infer<typeof kitReference>

const listShape = shapeOf(listSchema)
const kitShape = shapeOf(kitSchema)

export const readOccupationPlugins = (signal?: AbortSignal) => getJson('/api/occupation-plugins', listShape, { signal })

/** The plugin serving an occupation, if any. */
export const pluginFor = (list: OccupationPluginList | null, occupation: string) =>
  list?.plugins.find(plugin => plugin.occupations.includes(occupation)) ?? null

/** The source a plugin's role text was quoted from. */
export const sourceOf = (list: OccupationPluginList | null, plugin: OccupationPlugin) =>
  list?.sources.find(source => source.id === plugin.role.source) ?? null

/** owner/name of a GitHub URL (repository, file or folder), for a short source label. */
export const repositoryName = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+)/.exec(url)?.[1] ?? new URL(url).host

const kitPath = (agentId: string) => `/api/project-agents/${encodeURIComponent(agentId)}/occupation-kit`

export const readFlaKit = (personalSpaceId: string, agentId: string, signal?: AbortSignal) =>
  getJson(`${kitPath(agentId)}?${new URLSearchParams({ personalSpaceId })}`, kitShape, { signal })

/** The person's answer: which recommendations this FLA uses. Every earlier answer is kept. */
export const saveFlaKit = (personalSpaceId: string, agentId: string, skills: string[], mcpServers: string[]) =>
  putJson(kitPath(agentId), { personalSpaceId, skills, mcpServers }, kitShape)

/** The enabled ids after flipping one recommendation. */
export function toggled(items: readonly KitReference[], id: string): string[] {
  return items.filter(item => (item.id === id ? !item.enabled : item.enabled === true)).map(item => item.id)
}
