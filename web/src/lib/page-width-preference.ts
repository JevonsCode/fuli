import { ref } from 'vue'

/**
 * How wide a page's one column of cards may grow (PageStack): a comfortable
 * reading width, or the whole window. People differ (a wide monitor, a narrow
 * one), so it is the person's choice, kept per browser like the motion
 * preference; never sent anywhere.
 */
export const PAGE_WIDTH_STORAGE_KEY = 'fuli.pageWidth'

export type PageWidthPreference = 'comfortable' | 'full'

export const pageWidthPreference = ref<PageWidthPreference>('comfortable')

function readStoredPreference(): PageWidthPreference {
  if (typeof window === 'undefined') return 'comfortable'
  try {
    return window.localStorage.getItem(PAGE_WIDTH_STORAGE_KEY) === 'full' ? 'full' : 'comfortable'
  } catch {
    return 'comfortable'
  }
}

function applyToDocument(value: PageWidthPreference) {
  if (typeof document === 'undefined') return
  // PageStack.vue reads this attribute for its width.
  if (value === 'full') document.documentElement.dataset.pageWidth = 'full'
  else delete document.documentElement.dataset.pageWidth
}

export function initPageWidthPreference() {
  pageWidthPreference.value = readStoredPreference()
  applyToDocument(pageWidthPreference.value)
}

export function setPageWidthPreference(value: PageWidthPreference) {
  pageWidthPreference.value = value
  applyToDocument(value)
  try {
    if (value === 'full') window.localStorage.setItem(PAGE_WIDTH_STORAGE_KEY, value)
    else window.localStorage.removeItem(PAGE_WIDTH_STORAGE_KEY)
  } catch {
    // Storage can be unavailable; the choice still holds until the page is closed.
  }
}
