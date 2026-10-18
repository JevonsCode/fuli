/*
 * Workbench designs the lab can switch between. The current page is always
 * first; each concept adds one entry and its component, and the losers are
 * deleted once one is chosen.
 */
export interface WorkbenchVariant {
  id: string
  labelKey: string
}

export const WORKBENCH_VARIANTS: readonly WorkbenchVariant[] = [
  { id: 'current', labelKey: 'designLab.workbench.current' },
  { id: 'focus', labelKey: 'workbench.variants.focus' },
  { id: 'board', labelKey: 'workbench.variants.board' },
  { id: 'timeline', labelKey: 'workbench.variants.timeline' },
  { id: 'constellation', labelKey: 'workbench.variants.constellation' },
]
