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
// it, then read once, and read again while open when the role's settings or
// execution mode change (revision). Newest first; this section only reads.
const props = defineProps<{ role: ModelRoleId; revision: string }>()

const open = ref(false)
const entries = ref<HistoryEntry[] | null>(null)
const loading = ref(false)
const error = ref('')
const listId = computed(() => `model-history-${props.role}`)
let reading: AbortController | null = null

async function load() {
  reading?.abort()
  const current = new AbortController()
  reading = current
  loading.value = true
  error.value = ''
  try {
    const value = await readModelSettingsHistory(props.role, current.signal)
    if (reading === current) entries.value = value
  } catch (cause) {
    if (reading === current && (cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
  } finally {
    if (reading === current) loading.value = false
  }
}

function toggle() {
  open.value = !open.value
  if (open.value && !entries.value && !loading.value) void load()
}

watch(() => props.revision, () => { if (open.value) void load() })
onBeforeUnmount(() => reading?.abort())

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
      <p v-else-if="entries && !entries.length" class="m-0 text-sm text-muted-foreground" data-model-history-empty>
        {{ t('modelSettings.history.empty') }}
      </p>
      <ol v-else-if="entries" class="model-history-list">
        <li v-for="view in views" :key="view.key" :data-model-history-entry="view.marker ? 'marker' : 'change'">
          <time v-if="view.at" :datetime="view.at">{{ view.time }}</time>
          <ul>
            <li v-for="(line, index) in view.lines" :key="index" :class="{ 'text-muted-foreground': view.marker }">{{ line }}</li>
          </ul>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.model-history-list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; font-size: 14px; }
.model-history-list time { display: block; color: var(--color-muted); font-size: 12.5px; }
.model-history-list ul { margin: 0; padding: 0; list-style: none; overflow-wrap: anywhere; }
</style>
