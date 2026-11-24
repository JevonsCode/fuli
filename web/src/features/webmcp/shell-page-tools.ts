import { z } from 'zod'
import type { Router } from 'vue-router'

import { shapeOf } from '@/api/response-shape'

import { definePageTool } from './page-tool'

// Tools every console page offers the browser's AI agent (WebMCP): open a
// page, and search the person's knowledge. A page adds its own on top.

const PAGES = {
  home: 'today', inbox: 'inbox', knowledge: 'knowledge-default', organize: 'knowledge-organizer', tags: 'tags',
  workbench: 'project-agents', agents: 'agent-management', occupations: 'occupations', services: 'agent-services',
  apps: 'agent-apps', roundtables: 'roundtables', connections: 'connections',
  models: 'model-settings', settings: 'settings', me: 'personal-profile', howto: 'howto', about: 'about',
} as const
const SEARCH_LIMIT = 12
const TEXT_LIMIT = 280

const SEARCH_ITEM = z.looseObject({ id: z.string(), name: z.string().optional(), summary: z.string().nullish(), fact: z.string().nullish(), score: z.number().nullish() })
const SEARCH_SHAPE = shapeOf(z.looseObject({ entities: z.array(SEARCH_ITEM).optional(), facts: z.array(SEARCH_ITEM).optional() }))
type SearchItem = z.infer<typeof SEARCH_ITEM>

const clip = (text: string | null | undefined) => (text && text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT - 1)}…` : text)

export function shellPageTools(shell: { router: Router; spaceId: () => string }) {
  return [
    definePageTool({
      name: 'fuli_open_page',
      title: 'Open a FULI console page',
      description: 'Go to a console page: home, inbox (待决策), knowledge, organize, tags, workbench (FLAs), agents, occupations, services, apps, roundtables, connections, models, settings, me, howto, about. Each page offers its own tools once open.',
      input: z.object({ page: z.enum(Object.keys(PAGES) as [keyof typeof PAGES, ...(keyof typeof PAGES)[]]) }),
      routes: [],
      async run(input) {
        await shell.router.push({ name: PAGES[input.page] })
        return { opened: input.page, path: shell.router.currentRoute.value.fullPath }
      },
    }),
    definePageTool({
      name: 'fuli_search_knowledge',
      title: 'Search the person\'s knowledge',
      description: 'Search confirmed knowledge in the active space (optionally one project); pending items too when includePending is true.',
      input: z.object({ query: z.string().trim().min(1).max(500), projectId: z.string().min(1).optional(), includePending: z.boolean().optional() }),
      routes: ['GET /api/search'],
      readOnly: true,
      untrustedContent: true,
      async run(input, context) {
        const params = new URLSearchParams({ personalSpaceId: shell.spaceId(), q: input.query, limit: String(SEARCH_LIMIT),
          ...(input.projectId ? { personalProjectId: input.projectId } : {}), ...(input.includePending ? { pending: 'true' } : {}) })
        const result = await context.read(`/api/search?${params}`, SEARCH_SHAPE)
        const item = ({ id, name, summary, fact, score }: SearchItem) => ({ id, name, text: clip(fact ?? summary), score })
        return { entities: (result.entities ?? []).map(item), facts: (result.facts ?? []).map(item) }
      },
    }),
  ]
}
