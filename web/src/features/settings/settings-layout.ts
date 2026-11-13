import { useMediaQuery } from '@vueuse/core'
import { computed, ref } from 'vue'

// How the settings page lays out its topics, to compare two layouts in a real
// build: the tabs on top (A, the default) or the topics in a fixed column on
// the left with only the cards scrolling (B). Kept per browser like the FLAs
// page's layout; ?layout= picks one for a visit without keeping it.
export const SETTINGS_LAYOUTS = ['tabs', 'side'] as const
export type SettingsLayout = typeof SETTINGS_LAYOUTS[number]
const STORAGE_KEY = 'fuli.settings.layout'
// Where 今天 stacks its halves: narrower, the left column would squeeze the cards.
const SIDE_MIN_WIDTH = '(min-width: 861px)'

const layoutFrom = (value: unknown): SettingsLayout | undefined => SETTINGS_LAYOUTS.find(layout => layout === value)

function stored(): SettingsLayout {
  try { return layoutFrom(globalThis.localStorage?.getItem(STORAGE_KEY)) ?? 'tabs' } catch { return 'tabs' }
}

/** The chosen layout, the one shown (a narrow window always shows the tabs) and whether the choice applies here. */
export function useSettingsLayout(visit: unknown) {
  const chosen = ref<SettingsLayout>(layoutFrom(visit) ?? stored())
  const wide = useMediaQuery(SIDE_MIN_WIDTH)
  const shown = computed<SettingsLayout>(() => chosen.value === 'side' && wide.value ? 'side' : 'tabs')

  function choose(next: SettingsLayout) {
    chosen.value = next
    try {
      if (next === 'side') globalThis.localStorage?.setItem(STORAGE_KEY, next)
      else globalThis.localStorage?.removeItem(STORAGE_KEY)
    } catch {
      // Storage can be unavailable; the choice still holds on this page.
    }
  }
  return { chosen, shown, wide, choose }
}
