import { computed, ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export function projectBoardFilterKey(spaceId: string) {
  return `fuli:jefa:project-filter:v1:${encodeURIComponent(spaceId)}`
}

// View preferences only: never changes management permissions or report sharing.
export function useProjectBoardFilter(options: {
  enabled: Ref<boolean>
  spaceId: Ref<string>
  projectIds: Ref<string[]>
  ready: Ref<boolean>
}) {
  const route = useRoute()
  const router = useRouter()
  const selected = ref<string[] | null>(null) // null is the unsaved, dynamic all-project default.
  const invalidScope = ref(false)
  const storageUnavailable = ref(false)
  let resolved = false
  let scope = ''
  let importRoute = true

  watch([options.enabled, options.spaceId], ([enabled, spaceId]) => {
    const nextScope = enabled ? spaceId : ''
    if (nextScope === scope) return
    importRoute = !scope || !nextScope
    scope = nextScope
    selected.value = null
    resolved = false
    invalidScope.value = false
    storageUnavailable.value = false
    if (!scope) return
    try {
      const raw = localStorage.getItem(projectBoardFilterKey(scope))
      if (!raw) return
      const value: unknown = JSON.parse(raw)
      if (value && typeof value === 'object' && 'version' in value && value.version === 1
        && 'projectIds' in value && Array.isArray(value.projectIds)
        && value.projectIds.every(id => typeof id === 'string' && id.length > 0 && id === id.trim())) {
        selected.value = [...new Set(value.projectIds as string[])]
        resolved = true
      }
    } catch (error) {
      // Corrupt preferences can be replaced; a blocked browser store cannot be promised durable.
      storageUnavailable.value = !(error instanceof SyntaxError)
    }
  }, { immediate: true, flush: 'sync' })

  function persist() {
    if (!scope) return
    try {
      const key = projectBoardFilterKey(scope)
      if (selected.value === null) localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify({ version: 1, projectIds: selected.value }))
      storageUnavailable.value = false
    } catch { storageUnavailable.value = true }
  }

  function requestedIds() {
    const raw = route.query.project
    return [...new Set((Array.isArray(raw) ? raw : [raw]).filter((id): id is string => typeof id === 'string' && Boolean(id)))]
  }
  function routeIsEmpty() { return [route.query.empty].flat().includes('1') }
  function routeIsAll(ids: string[]) {
    return !ids.length && !routeIsEmpty() || ids.length === 1 && ['all', '__all__'].includes(ids[0]!)
  }
  const visibleIds = computed(() => options.projectIds.value.filter(id => selected.value === null || selected.value.includes(id)))
  function syncRoute() {
    if (!options.enabled.value || !scope || !options.ready.value || !resolved) return
    const ids = visibleIds.value
    const requested = requestedIds()
    const all = selected.value === null || ids.length > 0 && ids.length === options.projectIds.value.length
    if (all && route.query.project === 'all' && route.query.empty === undefined) return
    if (selected.value !== null && !routeIsAll(requested) && requested.length === ids.length && requested.every(id => ids.includes(id))
      && (ids.length > 0 || route.query.empty === '1')) return
    void router.replace({ query: { ...route.query,
      project: all ? 'all' : ids.length ? ids : '', empty: all || ids.length ? undefined : '1',
    } })
  }

  watch([options.enabled, options.spaceId, options.ready, options.projectIds,
    () => route.query.project, () => route.query.empty], () => {
    if (!options.enabled.value || !scope || !options.ready.value) return
    if (!resolved) {
      const requested = requestedIds()
      const all = !importRoute || routeIsAll(requested)
      invalidScope.value = !all && requested.some(id => !options.projectIds.value.includes(id))
      if (invalidScope.value) return
      selected.value = all ? null : [...new Set(requested)]
      resolved = true
      if (!all) persist() // Migrate existing links only after the catalog has loaded successfully.
    }
    syncRoute()
  }, { immediate: true })

  const selection = computed({
    get: () => visibleIds.value,
    set: (ids: string[]) => {
      if (!options.enabled.value || !scope || !options.ready.value) return
      // Preserve temporarily unavailable choices without silently including new projects.
      const unavailable = selected.value?.filter(id => !options.projectIds.value.includes(id)) ?? []
      selected.value = [...new Set([...unavailable, ...ids.filter(id => options.projectIds.value.includes(id))])]
      resolved = true
      invalidScope.value = false
      persist()
      syncRoute()
    },
  })
  function reset() {
    selected.value = null
    resolved = true
    invalidScope.value = false
    persist()
    syncRoute()
  }
  return { selection, reset, invalidScope, storageUnavailable }
}
