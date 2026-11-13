import { afterEach, describe, expect, it } from 'vitest'
import stackSource from '@/components/PageStack.vue?raw'
import { PAGE_WIDTH_STORAGE_KEY, initPageWidthPreference, pageWidthPreference, setPageWidthPreference } from './page-width-preference'

afterEach(() => {
  window.localStorage.removeItem(PAGE_WIDTH_STORAGE_KEY)
  delete document.documentElement.dataset.pageWidth
})

describe('page width preference', () => {
  it('starts comfortable, and a choice of full is kept for this browser and marked on the document', () => {
    initPageWidthPreference()
    expect(pageWidthPreference.value).toBe('comfortable')
    expect(document.documentElement.dataset.pageWidth).toBeUndefined()

    setPageWidthPreference('full')
    expect(document.documentElement.dataset.pageWidth).toBe('full')
    expect(window.localStorage.getItem(PAGE_WIDTH_STORAGE_KEY)).toBe('full')

    // A reload reads it back.
    delete document.documentElement.dataset.pageWidth
    initPageWidthPreference()
    expect(pageWidthPreference.value).toBe('full')
    expect(document.documentElement.dataset.pageWidth).toBe('full')

    setPageWidthPreference('comfortable')
    expect(document.documentElement.dataset.pageWidth).toBeUndefined()
    expect(window.localStorage.getItem(PAGE_WIDTH_STORAGE_KEY)).toBeNull()
  })

  it('is what the page column obeys: a readable width by default, no limit when full', () => {
    expect(stackSource).toMatch(/\.page-stack \{[^}]*max-width: 960px/)
    expect(stackSource).toMatch(/:root\[data-page-width="full"\] \.page-stack \{ max-width: none; \}/)
  })
})
