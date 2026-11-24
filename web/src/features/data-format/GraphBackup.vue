<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { UiNotice } from '@/ui'
import { readGraphBackup, revealGraphBackup, startGraphBackup, type GraphBackupJob, type GraphBackupView } from './model'
import { graphJobLabel, graphRefusal } from './graph-backup-words'
import { useGraphBackupJob } from './useGraphBackupJob'

// 「先备份图谱」 beside the graph step's confirmation (rec#17 graph/23): one
// click exports the whole graph into the data directory's backups/graph/,
// with FULI paused meanwhile, as `fuli graph export` does. The page says why
// it is worth it, the room it needs, each real step while it runs, then
// where the backup is and how big; a refusal or failure says why and what next.
const props = defineProps<{ version: number }>()
const view = ref<GraphBackupView | null>(null)
const revealError = ref('')
const job = useGraphBackupJob(() => props.version, () => { void load() })
const { running, outcome, notBack, refusal } = job

const latest = computed(() => view.value?.latest ?? null)
const room = computed(() => {
  const value = view.value?.room
  if (!value) return ''
  if (value.bytes !== null && value.freeBytes !== null) {
    return t('dataFormat.graphBackup.room', { size: formatBytes(value.bytes), free: formatBytes(value.freeBytes) })
  }
  return value.freeBytes !== null ? t('dataFormat.graphBackup.roomFree', { free: formatBytes(value.freeBytes) }) : ''
})
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
const refused = computed(() => refusal.value && graphRefusal(refusal.value, 'graphBackup'))

async function load() {
  try {
    view.value = await readGraphBackup(props.version)
    // A backup started before this page opened (or reloaded) is followed to its end.
    const current = view.value.job
    if (current?.action === 'backup' && current.status === 'running' && !running.value) job.follow(current)
  } catch {
    // The button still works; the room and the last backup are just not shown.
    view.value = null
  }
}

async function reveal(job: GraphBackupJob | null) {
  const name = job?.backup?.name ?? latest.value?.name
  if (!name) return
  revealError.value = ''
  try { await revealGraphBackup(props.version, name) } catch { revealError.value = t('dataFormat.graphBackup.revealFailed') }
}

onMounted(load)
</script>

<template>
  <div class="graph-backup" data-graph-backup>
    <p>{{ t('dataFormat.graphBackup.why') }}</p>
    <p v-if="latest" data-graph-backup-latest>
      {{ t('dataFormat.graphBackup.latest', { time: time(latest.createdAt), size: formatBytes(latest.bytes) }) }}
    </p>
    <p>{{ room }}{{ t('dataFormat.graphBackup.pause') }}</p>
    <GrowthLoading v-if="running" variant="inline" :label="graphJobLabel(running)" data-graph-backup-running />
    <div v-else class="graph-backup-actions">
      <Button :variant="latest ? 'outline' : 'default'" size="sm" data-graph-backup-start
        @click="job.start(() => startGraphBackup(version))">
        {{ latest ? t('dataFormat.graphBackup.again') : t('dataFormat.graphBackup.action') }}
      </Button>
      <Button v-if="latest" variant="ghost" size="sm" data-graph-backup-reveal @click="reveal(null)">
        {{ t('dataFormat.graphBackup.reveal') }}
      </Button>
    </div>

    <UiNotice v-if="outcome?.status === 'done' && outcome.backup" tone="success" data-graph-backup-done>
      {{ t('dataFormat.graphBackup.done', { path: outcome.backup.path, size: formatBytes(outcome.backup.bytes) }) }}
      <template #actions>
        <Button variant="ghost" size="sm" @click="reveal(outcome)">{{ t('dataFormat.graphBackup.reveal') }}</Button>
      </template>
    </UiNotice>
    <UiNotice v-else-if="outcome?.status === 'failed'" tone="error" data-graph-backup-failed>
      {{ t('dataFormat.graphBackup.failed', { reason: outcome.error ?? '' }) }}
      <template #actions>
        <Button variant="outline" size="sm" @click="job.start(() => startGraphBackup(version))">{{ t('dataFormat.graphBackup.retry') }}</Button>
      </template>
    </UiNotice>
    <UiNotice v-if="refused?.hostOnly" tone="error" data-graph-backup-refused data-no-action="the sentence names the computer and app to do it in">
      {{ refused.text }}
    </UiNotice>
    <UiNotice v-else-if="refused" tone="error" data-graph-backup-refused>
      {{ refused.text }}
      <template #actions>
        <Button variant="outline" size="sm" @click="job.start(() => startGraphBackup(version))">{{ t('dataFormat.graphBackup.retry') }}</Button>
      </template>
    </UiNotice>
    <UiNotice v-if="notBack" tone="warning" data-graph-backup-not-back>
      {{ t('dataFormat.graphBackup.notBack') }}
      <template #actions>
        <Button variant="outline" size="sm" @click="job.resume()">{{ t('dataFormat.graphBackup.checkAgain') }}</Button>
      </template>
    </UiNotice>
    <p v-if="revealError" class="graph-backup-error" role="alert">{{ revealError }}</p>
  </div>
</template>

<style scoped>
.graph-backup { display: grid; gap: 8px; max-width: var(--measure); justify-items: start; }
.graph-backup p { margin: 0; color: var(--color-muted); font-size: 14px; line-height: 1.6; }
.graph-backup-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.graph-backup-error { color: var(--color-danger) !important; }
</style>
