import { defineAsyncComponent, type Component } from 'vue'

// The console's movable pieces (Jevons 11-01: 「尽量都模块化……改位置要方便……
// 以后可能开放工作台让用户自定义」). A widget is self-contained: it reads its own
// data and assumes nothing about where it sits. The registry says what each
// widget is and which slots may hold it; the layout (layout.ts) says what each
// slot shows. Moving a widget is a layout change, never a page edit.
// The FLA page's column has three places, in its reading order (docs/fla-page.md):
// fla.overview (the work on its hands), fla.history (where and in which line it
// worked) and fla.profile (what it learned, its starter kit). Its own sections
// 最近做完 and 负责什么 sit between them.
export const SLOT_IDS = ['shell.aboveDock', 'fla.overview', 'fla.history', 'fla.profile'] as const
export type SlotId = typeof SLOT_IDS[number]

export interface WidgetDefinition {
  /** The component; it takes the slot's context as props (e.g. an FLA's id on its page). */
  component: Component
  /** Slots this widget is built to sit in; a layout naming it elsewhere is ignored. */
  slots: readonly SlotId[]
}

export const WIDGETS = {
  'team-cards': {
    component: defineAsyncComponent(() => import('@/features/team-work/TeamCardsWidget.vue')),
    slots: ['fla.overview'],
  },
  'fla-blocked': {
    component: defineAsyncComponent(() => import('@/features/fla-page/FlaBlockedTasks.vue')),
    slots: ['fla.overview'],
  },
  'fla-sheets': {
    component: defineAsyncComponent(() => import('@/features/fla-page/FlaTaskSheets.vue')),
    slots: ['fla.overview'],
  },
  'fla-growth': {
    component: defineAsyncComponent(() => import('@/features/fla-page/FlaGrowth.vue')),
    slots: ['fla.overview', 'fla.profile'],
  },
  'fla-kit': {
    component: defineAsyncComponent(() => import('@/features/fla-page/FlaOccupationKit.vue')),
    slots: ['fla.overview', 'fla.profile'],
  },
  'workstream-ledger': {
    component: defineAsyncComponent(() => import('@/features/projects/WorkstreamLedgerWidget.vue')),
    slots: ['fla.overview', 'fla.history'],
  },
  'fla-work-locations': {
    component: defineAsyncComponent(() => import('@/features/fla-page/FlaWorkLocations.vue')),
    slots: ['fla.overview', 'fla.history'],
  },
  'team-island': {
    component: defineAsyncComponent(() => import('@/features/team-work/TeamIsland.vue')),
    slots: ['shell.aboveDock'],
  },
} as const satisfies Record<string, WidgetDefinition>
export type WidgetId = keyof typeof WIDGETS

export const isWidgetId = (value: string): value is WidgetId => Object.hasOwn(WIDGETS, value)
