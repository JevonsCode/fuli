import { useMediaQuery } from '@vueuse/core'
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'

// How the settings page lays out its topics. Both layouts stay, and a person
// switches between them: the topics in a fixed column on the left with only
// the cards scrolling (the default, Jevons 11-15) or the tabs on top. Only a
// choice away from the default is kept, per browser like the FLAs page's
// layout; ?layout= picks one for a visit without keeping it.
export const SETTINGS_LAYOUTS = ['tabs', 'side'] as const
export type SettingsLayout = typeof SETTINGS_LAYOUTS[number]
export const DEFAULT_SETTINGS_LAYOUT: SettingsLayout = 'side'
const STORAGE_KEY = 'fuli.settings.layout'
// Where 今天 stacks its halves: narrower, the left column would squeeze the cards.
const SIDE_MIN_WIDTH = '(min-width: 861px)'

const layoutFrom = (value: unknown): SettingsLayout | undefined => SETTINGS_LAYOUTS.find(layout => layout === value)

function stored(): SettingsLayout {
  try { return layoutFrom(globalThis.localStorage?.getItem(STORAGE_KEY)) ?? DEFAULT_SETTINGS_LAYOUT } catch { return DEFAULT_SETTINGS_LAYOUT }
}

/** The chosen layout, the one shown (a narrow window always shows the tabs) and whether the choice applies here. `visit` follows a `?layout=` in the address, so a link or Back changes the layout while the page stays open. */
export function useSettingsLayout(visit: MaybeRefOrGetter<unknown>) {
  const chosen = ref<SettingsLayout>(layoutFrom(toValue(visit)) ?? stored())
  watch(() => toValue(visit), value => { chosen.value = layoutFrom(value) ?? stored() })
  const wide = useMediaQuery(SIDE_MIN_WIDTH)
  const shown = computed<SettingsLayout>(() => chosen.value === 'side' && wide.value ? 'side' : 'tabs')

  function choose(next: SettingsLayout) {
    chosen.value = next
    try {
      if (next === DEFAULT_SETTINGS_LAYOUT) globalThis.localStorage?.removeItem(STORAGE_KEY)
      else globalThis.localStorage?.setItem(STORAGE_KEY, next)
    } catch {
      // Storage can be unavailable; the choice still holds on this page.
    }
  }
  return { chosen, shown, wide, choose }
}
