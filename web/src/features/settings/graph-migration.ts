import { z } from 'zod'
import { getJson, postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// The one-click move of an older install's Docker graph (src/system/graph-migration.js).
// The guide is outside the package on purpose: an AI follows it when the click cannot finish.
export const LEGACY_MIGRATION_GUIDE_URL =
  'https://github.com/JevonsCode/fuli/blob/main/migration-guides/legacy-graph-data/SKILL.md'

const migrationSchema = z.looseObject({
  status: z.enum(['running', 'migrated', 'already_native', 'failed']),
  error: z.string().nullish(),
  finishedAt: z.string().nullish(),
})
export type GraphMigration = z.infer<typeof migrationSchema>

const answer = shapeOf(z.looseObject({ migration: migrationSchema.nullable() }))
const MIGRATION_PATH = '/api/system/graph-migration'

export const readGraphMigration = async () => (await getJson(MIGRATION_PATH, answer)).migration
export const startGraphMigration = async () => (await postJson(MIGRATION_PATH, {}, answer)).migration
