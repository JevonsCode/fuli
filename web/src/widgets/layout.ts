import { isWidgetId, SLOT_IDS, WIDGETS, type SlotId, type WidgetId } from './registry'

/** Which widgets each slot shows, in order. Plain data, so a person's saved layout can replace it later. */
export type WidgetLayout = Record<SlotId, string[]>

/** The layout today: one code default. */
export const DEFAULT_LAYOUT: WidgetLayout = {
  'workbench.feed': ['team-cards'],
  'shell.aboveDock': ['team-island'],
  'fla.overview': ['fla-sheets'],
}

// A stored layout is untrusted data: unknown slots and widgets, widgets in a
// slot they were not built for, and repeats are dropped; a missing slot keeps
// its default. A widget appears in at most one slot, so it never reads twice.
export function resolveLayout(saved: Partial<Record<string, unknown>> | null | undefined): Record<SlotId, WidgetId[]> {
  const placed = new Set<WidgetId>()
  return Object.fromEntries(SLOT_IDS.map((slot) => {
    const listed = Array.isArray(saved?.[slot]) ? saved![slot] as unknown[] : DEFAULT_LAYOUT[slot]
    const widgets = listed.filter((id): id is WidgetId => typeof id === 'string' && isWidgetId(id)
      && (WIDGETS[id].slots as readonly SlotId[]).includes(slot) && !placed.has(id) && Boolean(placed.add(id)))
    return [slot, widgets]
  })) as Record<SlotId, WidgetId[]>
}

// Once people can arrange their workbench, their saved layout (user
// settings) goes in place of null here; until then the default applies.
const layout = resolveLayout(null)

export function useWidgetLayout() {
  return { widgetsIn: (slot: SlotId) => layout[slot] }
}
