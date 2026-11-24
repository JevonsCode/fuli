import { computed, ref } from 'vue'
import { z } from 'zod'

import { postJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'

// The console's advanced areas stay out of sight until this installation has
// used them (Jevons 11-15). This is the one place that decides: components
// wrap themselves in AdvancedOnly.vue or ask shown(); nothing else holds a
// condition of its own. The server records what is shown
// (src/advanced-areas/advanced-areas.js) and adds an area when it finds a
// trace of it; here a reveal by the person or by a link takes effect at once.
// Nothing removes an area once shown.
const ADVANCED_AREAS = ['roundtable', 'tonborg', 'tidy', 'lan'] as const
export type AdvancedArea = typeof ADVANCED_AREAS[number]

// A console link that belongs to an area: its path (and the paths under it
// with prefix), and the query value or hash that names the area's card.
interface AreaLink { path: string; prefix?: boolean; query?: Readonly<Record<string, string>>; hash?: string }
interface AreaEntry {
  links: readonly AreaLink[]
  // The AI-permission categories (Settings › AI) that are about this area.
  delegationCategories: readonly string[]
}

const AREAS: Readonly<Record<AdvancedArea, AreaEntry>> = {
  // 圆桌: group discussions live inside it.
  roundtable: { links: [{ path: '/roundtables', prefix: true }], delegationCategories: ['roundtable'] },
  // 交给 Tonborg 确认 and the judgment standards.
  tonborg: { links: [{ path: '/employees/tonborg', query: { view: 'standards' } }], delegationCategories: [] },
  // 整理: the organize page, the project card, the preferences start, Dreaming.
  tidy: { links: [{ path: '/organize', prefix: true }], delegationCategories: [] },
  // LAN pairing: the peer card, visit requests, guest links.
  lan: {
    links: [{ path: '/visit-requests', prefix: true }, { path: '/settings', hash: '#peer' }, { path: '/settings', query: { setting: 'peer' } }],
    delegationCategories: ['lan_roundtable'],
  },
}

const shownShape = shapeOf(z.looseObject({ shown: z.array(z.string()) }))
// What the server said is shown at the last state read; null before the first.
const observed = ref<ReadonlySet<string> | null>(null)
// What the person or a link revealed in this console, kept even before the server answers.
const revealed = ref<ReadonlySet<AdvancedArea>>(new Set())

/** The console store's state read: the areas the server shows. A server that sends none shows them all. */
export function adoptShownAreas(shownIds: readonly string[] | undefined) {
  observed.value = new Set(shownIds ?? ADVANCED_AREAS)
}

export function shown(area: AdvancedArea): boolean {
  return revealed.value.has(area) || observed.value?.has(area) === true
}

/** The areas not shown yet, in their order. */
export const hiddenAreas = computed(() => ADVANCED_AREAS.filter(area => !shown(area)))

/** Shows the area at once and for good; why: the person pressed Show, or a link led there. */
export function reveal(area: AdvancedArea, why: 'person' | 'link' = 'person') {
  if (shown(area)) return
  revealed.value = new Set([...revealed.value, area])
  // The local copy already shows it; a lost answer is found again by the next reveal or state read.
  void postJson('/api/advanced-areas/reveal', { id: area, why }, shownShape).catch(() => undefined)
}

interface RouteLike { path: string; query?: Readonly<Record<string, unknown>>; hash?: string }

/** The area a console location belongs to, if any. */
export function areaFor(route: RouteLike): AdvancedArea | undefined {
  return ADVANCED_AREAS.find(area => AREAS[area].links.some(link => matches(link, route)))
}

function matches(link: AreaLink, route: RouteLike): boolean {
  const onPath = route.path === link.path || (link.prefix === true && route.path.startsWith(`${link.path}/`))
  if (!onPath) return false
  if (link.hash) return route.hash === link.hash
  if (link.query) return Object.entries(link.query).every(([key, value]) => route.query?.[key] === value)
  return true
}

/** Whether an AI-permission category is shown: one about a hidden area waits with it. */
export function delegationCategoryShown(categoryId: string): boolean {
  const area = ADVANCED_AREAS.find(id => AREAS[id].delegationCategories.includes(categoryId))
  return !area || shown(area)
}
