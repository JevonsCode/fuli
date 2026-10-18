import { computed, ref, watch, type Ref } from 'vue'
import { deleteJson, getJson, postJson, putJson } from '@/api/client'
import { currentLocale } from '@/i18n'

// The space's occupation catalog (R-05): built-in and custom occupations, each
// with the work it covers. One cache for the whole console, so every chip and
// editor shows the same names without reading the catalog again.
export interface OccupationEntry {
  key: string
  name_zh: string
  name_en: string
  description_zh: string
  description_en: string
  builtin: boolean
  status: 'active' | 'archived'
  revision: number
  agent_count: number
  created_at: string
  updated_at: string
}

export interface OccupationDraft { name: string; description: string }

const entries = ref<OccupationEntry[]>([])
const loadedSpace = ref('')
const loading = ref(false)
const error = ref('')
let pending: Promise<void> | null = null

const english = () => currentLocale().startsWith('en')
export const occupationName = (entry: OccupationEntry) => (english() ? entry.name_en : entry.name_zh) || entry.name_zh || entry.key
export const occupationDescription = (entry: OccupationEntry) => (english() ? entry.description_en : entry.description_zh) || entry.description_zh

/** The loaded entry for a key, or null before the catalog is read. */
export function occupationEntry(key: string | null | undefined) {
  return key ? entries.value.find(entry => entry.key === key) ?? null : null
}

async function read(spaceId: string) {
  loading.value = true
  error.value = ''
  try {
    const value = await getJson<OccupationEntry[]>(`/api/occupations?${new URLSearchParams({ personalSpaceId: spaceId })}`)
    entries.value = Array.isArray(value) ? value : []
    loadedSpace.value = spaceId
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    loading.value = false
    pending = null
  }
}

function replace(next: OccupationEntry) {
  entries.value = entries.value.some(entry => entry.key === next.key)
    ? entries.value.map(entry => (entry.key === next.key ? next : entry))
    : [...entries.value, next]
}

// The same text goes to both locales; the service keeps whichever is given.
const fields = (draft: OccupationDraft) => english()
  ? { name_en: draft.name.trim(), description_en: draft.description.trim() }
  : { name_zh: draft.name.trim(), description_zh: draft.description.trim() }

export function useOccupationCatalog(spaceId: Ref<string>) {
  function load(options: { force?: boolean } = {}) {
    if (!spaceId.value) return Promise.resolve()
    if (!options.force && loadedSpace.value === spaceId.value) return Promise.resolve()
    pending ??= read(spaceId.value)
    return pending
  }
  watch(spaceId, () => { void load() }, { immediate: true })

  const space = () => ({ personalSpaceId: spaceId.value })
  const path = (key: string) => `/api/occupations/${encodeURIComponent(key)}`
  return {
    entries: computed(() => (loadedSpace.value === spaceId.value ? entries.value : [])),
    active: computed(() => (loadedSpace.value === spaceId.value ? entries.value.filter(entry => entry.status === 'active') : [])),
    loading,
    error,
    load,
    create: async (draft: OccupationDraft) => replace(await postJson<OccupationEntry>('/api/occupations', { ...space(), ...fields(draft) })),
    update: async (entry: OccupationEntry, draft: OccupationDraft) =>
      replace(await putJson<OccupationEntry>(path(entry.key), { ...space(), revision: entry.revision, ...fields(draft) })),
    archive: async (entry: OccupationEntry) =>
      replace(await postJson<OccupationEntry>(`${path(entry.key)}/archive`, { ...space(), revision: entry.revision })),
    restore: async (entry: OccupationEntry) =>
      replace(await putJson<OccupationEntry>(path(entry.key), { ...space(), revision: entry.revision, status: 'active' })),
    remove: async (entry: OccupationEntry) => {
      await deleteJson(path(entry.key), { ...space(), revision: entry.revision })
      entries.value = entries.value.filter(item => item.key !== entry.key)
    },
  }
}
