<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { UiNotice } from '@/ui'
import { readGraphBackup, startGraphRestore, type GraphBackupCopy } from './model'
import { graphJobLabel, graphRefusal } from './graph-backup-words'
import { useGraphBackupJob } from './useGraphBackupJob'

// The graph step's undo was refused because records changed since: only the
// backup taken before the confirmation goes back (「先备份图谱」,
// console-graph-backup.js). The person sees which backup and that every
// later change is lost, confirms, and FULI restarts around the same import
// `fuli graph import` runs (it keeps a copy of the graph as it is first).
const props = defineProps<{ version: number }>()
// restored: what to say once it is back; the page reads its plan again, which drops this entry.
// busy: FULI is stopped for it, so the page holds the undo back.
const emit = defineEmits<{ restored: [message: string]; busy: [running: boolean] }>()
const backup = ref<GraphBackupCopy | null>(null)
const loaded = ref(false)
const confirming = ref(false)
const time = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
const understood = ref(false)
const job = useGraphBackupJob(() => props.version, (finished) => {
  if (finished.status === 'done') emit('restored', t('dataFormat.graphRestore.done', { time: time(finished.backup?.createdAt ?? '') }))
})
const { running, outcome, notBack, refusal } = job
watch(running, value => emit('busy', value !== null), { immediate: true })
onBeforeUnmount(() => emit('busy', false))
const refused = computed(() => refusal.value && graphRefusal(refusal.value, 'graphRestore'))

function restore() {
  if (!backup.value || !understood.value) return
  const { name } = backup.value
  confirming.value = false
  void job.start(() => startGraphRestore(props.version, name))
}

onMounted(async () => {
  try { backup.value = (await readGraphBackup(props.version)).latest } catch { backup.value = null }
  loaded.value = true
})
</script>

<template>
  <div class="graph-restore" data-graph-restore>
    <UiNotice v-if="loaded && !running && outcome?.status !== 'done'" tone="error" data-graph-restore-offer>
      {{ t('dataFormat.graphRestore.refused') }}
      <template v-if="backup"> {{ t('dataFormat.graphRestore.backup', { time: time(backup.createdAt), size: formatBytes(backup.bytes) }) }}</template>
      <template v-else> {{ t('dataFormat.graphRestore.none') }}</template>
      <template #actions>
        <Button v-if="backup" variant="outline" size="sm" data-graph-restore-open @click="confirming = true">
          {{ t('dataFormat.graphRestore.open') }}
        </Button>
        <Button v-else as-child variant="outline" size="sm">
          <RouterLink to="/settings#storage" data-graph-restore-others>{{ t('dataFormat.graphRestore.others') }}</RouterLink>
        </Button>
      </template>
    </UiNotice>
    <div v-if="confirming && backup" class="graph-restore-confirm" data-graph-restore-confirm>
      <div class="graph-restore-check">
        <Checkbox id="graph-restore-understood" v-model="understood" />
        <Label for="graph-restore-understood">{{ t('dataFormat.graphRestore.understand', { time: time(backup.createdAt) }) }}</Label>
      </div>
      <p class="graph-restore-local" data-graph-restore-local>{{ t('dataFormat.graphRestore.local') }}</p>
      <div class="graph-restore-actions">
        <Button variant="destructive" size="sm" :disabled="!understood" data-graph-restore-start @click="restore">
          {{ t('dataFormat.graphRestore.confirm') }}
        </Button>
        <Button variant="ghost" size="sm" @click="confirming = false">{{ t('dataFormat.graphRestore.cancel') }}</Button>
      </div>
    </div>
    <GrowthLoading v-if="running" variant="inline" :label="graphJobLabel(running)" data-graph-restore-running />
    <UiNotice v-if="outcome?.status === 'failed'" tone="error" data-graph-restore-failed>
      {{ t('dataFormat.graphRestore.failed', { reason: outcome.error ?? '' }) }}
      <template #actions>
        <Button variant="outline" size="sm" @click="confirming = true">{{ t('dataFormat.graphRestore.retry') }}</Button>
      </template>
    </UiNotice>
    <UiNotice v-if="refused?.hostOnly" tone="error" data-graph-restore-refused data-no-action="the sentence names the computer and app to do it in">
      {{ refused.text }}
    </UiNotice>
    <UiNotice v-else-if="refused" tone="error" data-graph-restore-refused>
      {{ refused.text }}
      <template #actions>
        <Button variant="outline" size="sm" @click="confirming = true">{{ t('dataFormat.graphRestore.retry') }}</Button>
      </template>
    </UiNotice>
    <UiNotice v-if="notBack" tone="warning" data-graph-restore-not-back>
      {{ t('dataFormat.graphBackup.notBack') }}
      <template #actions>
        <Button variant="outline" size="sm" @click="job.resume()">{{ t('dataFormat.graphBackup.checkAgain') }}</Button>
      </template>
    </UiNotice>
  </div>
</template>

<style scoped>
.graph-restore { display: grid; gap: 8px; flex-basis: 100%; justify-items: start; }
.graph-restore-confirm { display: grid; gap: 8px; }
.graph-restore-local { margin: 0; color: var(--color-muted); font-size: 14px; line-height: 1.6; }
.graph-restore-check { display: flex; align-items: flex-start; gap: 10px; }
.graph-restore-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
