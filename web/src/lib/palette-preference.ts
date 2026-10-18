import { ref } from 'vue'

/** Per-browser convenience, like the interface language; never sent anywhere. */
export const PALETTE_STORAGE_KEY = 'fuli.palette'

export const PALETTES = ['jade', 'ink', 'gold', 'indigo', 'sprout'] as const
export type Palette = (typeof PALETTES)[number]
const DEFAULT_PALETTE: Palette = 'jade'

export const palettePreference = ref<Palette>(DEFAULT_PALETTE)

const isPalette = (value: unknown): value is Palette => PALETTES.includes(value as Palette)

function readStoredPalette(): Palette {
  if (typeof window === 'undefined') return DEFAULT_PALETTE
  try {
    const stored = window.localStorage.getItem(PALETTE_STORAGE_KEY)
    return isPalette(stored) ? stored : DEFAULT_PALETTE
  } catch {
    return DEFAULT_PALETTE
  }
}

function applyToDocument(value: Palette) {
  if (typeof document === 'undefined') return
  // palettes.css re-points the tokens for this attribute; the default has none.
  if (value === DEFAULT_PALETTE) delete document.documentElement.dataset.palette
  else document.documentElement.dataset.palette = value
}

export function initPalettePreference() {
  palettePreference.value = readStoredPalette()
  applyToDocument(palettePreference.value)
}

export function setPalettePreference(value: Palette) {
  palettePreference.value = value
  applyToDocument(value)
  if (typeof window === 'undefined') return
  try {
    if (value === DEFAULT_PALETTE) window.localStorage.removeItem(PALETTE_STORAGE_KEY)
    else window.localStorage.setItem(PALETTE_STORAGE_KEY, value)
  } catch {
    // Storage can be unavailable; the choice still applies to this page.
  }
}
