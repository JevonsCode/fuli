import { onBeforeUnmount, readonly, ref, toValue, watchEffect, type MaybeRefOrGetter } from 'vue'
import { useRoute } from 'vue-router'

// The shell renders the page's one H1. A route's meta.title is its static
// name; a page about one record (an Agent's profile) names itself instead,
// so the H1 is the record's real name. Empty text falls back to meta.title.
interface PageTitle { owner: symbol | null; path: string; text: string }
const current = ref<PageTitle>({ owner: null, path: '', text: '' })

/** The current dynamic title; the shell uses it only on the path that set it. */
export const pageTitle = readonly(current)

export function usePageTitle(text: MaybeRefOrGetter<string>) {
  const route = useRoute()
  const owner = Symbol('page-title')
  watchEffect(() => {
    current.value = { owner, path: route.path, text: toValue(text).trim() }
  })
  onBeforeUnmount(() => {
    if (current.value.owner === owner) current.value = { owner: null, path: '', text: '' }
  })
}
