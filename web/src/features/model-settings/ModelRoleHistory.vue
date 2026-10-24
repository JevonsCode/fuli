<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'

import { historyLines, readModelSettingsHistory, type HistoryEntry } from './history'
import { roleName, type ModelRoleId } from './model'

// 变更记录 inside a role's row (rec#11 D-42): collapsed until the person opens
// it, then read on every opening, and again while open whenever the page
// saved a change (version, a counter the page bumps: a content hash can come
// back to an earlier value). Each read is tagged with the role and version it
// was asked for; a change aborts the read in flight, and an answer for a
// version that is no longer current is dropped (and asked again while open).
// A failed refresh keeps what was read. Newest first; this section only reads.
const props = defineProps<{ role: ModelRoleId; version: number }>()

type ReadTarget = { role: ModelRoleId; version: number }
const open = ref(false)
const entries = ref<HistoryEntry[] | null>(null)
const loading = ref(false)
const error = ref('')
const listId = computed(() => `model-history-${props.role}`)
const isCurrent = (target: ReadTarget | null) => target?.role === props.role && target.version === props.version
let reading: { request: AbortController; target: ReadTarget } | null = null

function stop() {
  reading?.request.abort()
  reading = null
  loading.value = false
}

async function load() {
  stop()
  const read = { request: new AbortController(), target: { role: props.role, version: props.version } }
  reading = read
  loading.value = true
  error.value = ''
  try {
    const value = await readModelSettingsHistory(read.target.role, read.request.signal)
    if (reading !== read) return
    if (!isCurrent(read.target)) {
      stop()
      if (open.value) void load()
      return
    }
    entries.value = value
  } catch (cause) {
    if (reading === read && (cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
  } finally {
    if (reading === read) {
      reading = null
      loading.value = false
    }
  }
}

function toggle() {
  open.value = !open.value
  // Another tab or process may have changed the settings meanwhile.
  if (open.value && !isCurrent(reading?.target ?? null)) void load()
}

watch(() => [props.role, props.version], () => {
  stop()
  if (open.value) void load()
})
onBeforeUnmount(stop)

const views = computed(() => (entries.value ?? []).map((entry, index) => ({
  key: entry.changedAt === null ? `${entry.kind}-${index}` : entry.changeId,
  marker: entry.changedAt === null,
  at: entry.changedAt,
  time: entry.changedAt ? formatDateTime(entry.changedAt, currentLocale(), DATE_TIME_MINUTE, { missing: '' }) : '',
  lines: historyLines(entry, currentLocale()),
})))
</script>

<template>
  <section class="model-role-history grid gap-2 border-t pt-3" :data-model-history="role">
    <div class="flex items-center gap-2">
      <Button variant="ghost" size="sm" class="-ml-2" :aria-expanded="open" :aria-controls="listId" data-model-history-toggle
        @click="toggle">
        {{ t('modelSettings.history.title') }}
      </Button>
      <GrowthLoading v-if="open && loading && entries" variant="inline" :label="t('modelSettings.history.loading', { name: roleName(role) })" />
    </div>
    <div v-if="open" :id="listId">
      <GrowthLoading v-if="loading && !entries" variant="compact" :label="t('modelSettings.history.loading', { name: roleName(role) })" />
      <p v-else-if="error && !entries" class="m-0 text-sm text-destructive" role="alert">
        {{ t('modelSettings.history.loadFailed') }} {{ error }}
        <Button variant="link" size="sm" class="px-1" @click="load">{{ t('modelSettings.retry') }}</Button>
      </p>
      <template v-else-if="entries">
        <!-- A failed refresh keeps the list read before. -->
        <p v-if="error" class="m-0 mb-2 text-xs text-destructive" role="alert" data-model-history-refresh-failed>
          {{ t('modelSettings.history.refreshFailed') }}
          <Button variant="link" size="sm" class="h-auto px-1 text-xs" :disabled="loading" @click="load">{{ t('modelSettings.retry') }}</Button>
        </p>
        <p v-if="!entries.length" class="m-0 text-sm text-muted-foreground" data-model-history-empty>
          {{ t('modelSettings.history.empty') }}
        </p>
        <ol v-else class="model-history-list">
          <li v-for="view in views" :key="view.key" :data-model-history-entry="view.marker ? 'marker' : 'change'">
            <time v-if="view.at" :datetime="view.at">{{ view.time }}</time>
            <ul>
              <li v-for="(line, index) in view.lines" :key="index" :class="{ 'text-muted-foreground': view.marker }">{{ line }}</li>
            </ul>
          </li>
        </ol>
      </template>
    </div>
  </section>
</template>

<style scoped>
.model-history-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; font-size: 14px; }
.model-history-list time { display: block; color: var(--color-muted); font-size: 12.5px; }
.model-history-list ul { margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; }
</style>
