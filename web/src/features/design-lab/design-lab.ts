import { ref, watch } from 'vue'

/*
 * Design lab: a temporary panel for trying palettes, motion and workbench
 * designs on the real console. Everything here is per browser and meant to be
 * deleted once a design is chosen; the winner moves into the product proper.
 */
const STORAGE_KEY = 'fuli.lab'

export const PAGE_TRANSITIONS = ['none', 'fade', 'rise'] as const
export type PageTransition = (typeof PAGE_TRANSITIONS)[number]

export interface DesignLabState {
  open: boolean
  x: number | null
  y: number | null
  transition: PageTransition
  cardLift: boolean
  workbench: string
}

const DEFAULTS: DesignLabState = { open: false, x: null, y: null, transition: 'none', cardLift: false, workbench: 'current' }

function read(): DesignLabState {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DesignLabState>
    return {
      ...DEFAULTS,
      ...stored,
      transition: PAGE_TRANSITIONS.includes(stored.transition as PageTransition) ? stored.transition as PageTransition : DEFAULTS.transition,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export const designLab = ref<DesignLabState>(typeof window === 'undefined' ? { ...DEFAULTS } : read())

function apply(state: DesignLabState) {
  if (typeof document === 'undefined') return
  const root = document.documentElement.dataset
  // design-lab.css reads these attributes; the defaults set none.
  if (state.transition === 'none') delete root.labTransition
  else root.labTransition = state.transition
  if (state.cardLift) root.labLift = 'on'
  else delete root.labLift
}

watch(designLab, state => {
  apply(state)
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}, { deep: true, immediate: true })

export function resetDesignLab() {
  designLab.value = { ...DEFAULTS, open: designLab.value.open, x: designLab.value.x, y: designLab.value.y }
}
