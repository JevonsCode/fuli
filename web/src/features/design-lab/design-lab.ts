import { ref, watch } from 'vue'

/*
 * Design lab: a temporary panel for trying palettes, motion and workbench
 * designs on the real console. Everything here is per browser and meant to be
 * deleted once a design is chosen; the winner moves into the product proper.
 */
const STORAGE_KEY = 'fuli.lab'

export const PAGE_TRANSITIONS = ['none', 'fade', 'rise'] as const
export type PageTransition = (typeof PAGE_TRANSITIONS)[number]
// A/B choices, each a design question from the UX review (see Notion).
export const LAB_CHOICES = {
  theme: ['light', 'dark'],
  cards: ['outline', 'shadow', 'flat'],
  density: ['compact', 'standard', 'roomy'],
  radius: ['small', 'medium', 'large'],
  ring: ['breathe', 'pulse', 'still'],
} as const
export type LabChoice = keyof typeof LAB_CHOICES
type Choices = { [K in LabChoice]: (typeof LAB_CHOICES)[K][number] }

export interface DesignLabState {
  open: boolean
  x: number | null
  y: number | null
  transition: PageTransition
  cardLift: boolean
  workbench: string
  choices: Choices
}

const DEFAULT_CHOICES: Choices = { theme: 'light', cards: 'outline', density: 'standard', radius: 'medium', ring: 'breathe' }
const DEFAULTS: DesignLabState = { open: false, x: null, y: null, transition: 'none', cardLift: false, workbench: 'current', choices: DEFAULT_CHOICES }

function validChoices(value: unknown): Choices {
  const stored = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(LAB_CHOICES).map(([key, options]) => [key,
    (options as readonly string[]).includes(stored[key] as string) ? stored[key] : DEFAULT_CHOICES[key as LabChoice]])) as Choices
}

function read(): DesignLabState {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<DesignLabState>
    return {
      ...DEFAULTS,
      ...stored,
      transition: PAGE_TRANSITIONS.includes(stored.transition as PageTransition) ? stored.transition as PageTransition : DEFAULTS.transition,
      choices: validChoices(stored.choices),
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
  // Each choice becomes data-lab-<name> unless it is the default; the theme
  // uses the existing data-theme switch.
  for (const key of Object.keys(LAB_CHOICES) as LabChoice[]) {
    const value = state.choices[key]
    const attribute = `lab${key[0]!.toUpperCase()}${key.slice(1)}`
    if (key === 'theme') {
      if (value === 'dark') root.theme = 'dark'
      else delete root.theme
    } else if (value === DEFAULT_CHOICES[key]) delete root[attribute]
    else root[attribute] = value
  }
}

watch(designLab, state => {
  apply(state)
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state)) } catch { /* storage may be unavailable */ }
}, { deep: true, immediate: true })

export function resetDesignLab() {
  designLab.value = { ...DEFAULTS, choices: { ...DEFAULT_CHOICES }, open: designLab.value.open, x: designLab.value.x, y: designLab.value.y }
}
