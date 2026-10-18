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
]
