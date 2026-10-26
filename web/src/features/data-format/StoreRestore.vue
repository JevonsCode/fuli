<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  describeRestore, readRestoreChoices, readRestoreStatus, refusalMessage, restoreFinished, startRestore,
  type RestoreImpact, type RestorableStore, type RestoreStatus,
} from '@/features/data-format/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'

// 整库恢复 (rec#17 D-09 part 2): the person picks a backup, reads what it
// discards, confirms, and FULI restarts around the restore. While FULI is
// stopped the page keeps asking for the outcome until the console answers.
const POLL_MS = 2000
const GIVE_UP_MS = 5 * 60_000

const emit = defineEmits<{ restored: [] }>()
const open = ref(false)
const loading = ref(false)
const loadError = ref('')
const stores = ref<RestorableStore[]>([])
const choice = ref('')
const impact = ref<RestoreImpact | null>(null)
const describing = ref(false)
const understood = ref(false)
const starting = ref(false)
const running = ref<RestoreStatus | null>(null)
const outcome = ref<RestoreStatus | null>(null)
const notBack = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

const options = computed(() => stores.value.flatMap(store => store.backups.map(backup => ({
  value: `${store.label}\n${backup.ref}`,
  text: t('dataFormat.restore.option', { label: store.label, time: time(backup.takenAt), version: backup.version ?? '-' }),
}))))
const chosen = computed(() => {
  const [label = '', backupRef = ''] = choice.value.split('\n')
  return { label, backupRef }
})

function time(value: string | null) {
  return formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '—' })
}

async function load() {
  open.value = true
  loading.value = true
  loadError.value = ''
  try {
    const result = await readRestoreChoices()
    stores.value = result.stores
    if (result.restore && !restoreFinished(result.restore, result.restore.id)) follow(result.restore)
  } catch (cause) {
    loadError.value = refusalMessage(cause)
  } finally {
    loading.value = false
  }
}

function choose(value: string | number | bigint | Record<string, unknown> | null | undefined) {
  choice.value = typeof value === 'string' ? value : ''
  impact.value = null
  understood.value = false
  error.value = ''
}

async function describe() {
  if (!choice.value) return
  describing.value = true
  error.value = ''
  try {
    impact.value = (await describeRestore(chosen.value.label, chosen.value.backupRef)).impact
    understood.value = false
  } catch (cause) {
    error.value = refusalMessage(cause)
  } finally {
    describing.value = false
  }
}

async function confirm() {
  if (!impact.value || !understood.value) return
  starting.value = true
  error.value = ''
  outcome.value = null
  try {
    follow(await startRestore(chosen.value.label, chosen.value.backupRef, impact.value.currentDigest))
  } catch (cause) {
    error.value = refusalMessage(cause)
  } finally {
    starting.value = false
  }
}

// Asks for the outcome until this restore finished; FULI is down meanwhile, so a failed read is expected.
function follow(status: RestoreStatus) {
  running.value = status
  notBack.value = false
  const deadline = Date.now() + GIVE_UP_MS
  const ask = async () => {
    if (unmounted) return
    let latest: RestoreStatus | null = null
    try { latest = (await readRestoreStatus()).restore } catch { /* FULI is restarting */ }
    if (unmounted) return
    if (latest && restoreFinished(latest, status.id)) {
      outcome.value = latest
      running.value = null
      impact.value = null
      choice.value = ''
      emit('restored')
      return
    }
    if (Date.now() >= deadline) {
      running.value = null
      notBack.value = true
      return
    }
    timer = setTimeout(ask, POLL_MS)
  }
  if (restoreFinished(status, status.id)) void ask()
  else timer = setTimeout(ask, POLL_MS)
}

function outcomeText(status: RestoreStatus) {
  const values = { label: status.label, backup: status.backupRef, safety: status.safetyBackupRef ?? '',
    reason: status.error ?? '' }
  if (status.status === 'failed') return t('dataFormat.restore.failed', values)
  return status.error ? t('dataFormat.restore.restoredWithError', values) : t('dataFormat.restore.restored', values)
}

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(timer)
})
</script>

<template>
  <Card as="section" class="store-restore" aria-labelledby="store-restore-title" data-store-restore>
    <CardHeader>
      <CardTitle id="store-restore-title" as="h2">{{ t('dataFormat.restore.title') }}</CardTitle>
      <CardDescription>{{ t('dataFormat.restore.lede') }}</CardDescription>
    </CardHeader>
    <div class="store-restore-body">
      <p v-if="outcome" :role="outcome.status === 'failed' ? 'alert' : 'status'" :data-restore-outcome="outcome.status">
        {{ outcomeText(outcome) }}
      </p>
      <p v-if="notBack" role="alert">{{ t('dataFormat.restore.notBack') }}</p>
      <GrowthLoading v-if="running" variant="inline" :label="t('dataFormat.restore.running', { label: running.label })" />

      <template v-else>
        <div v-if="!open">
          <Button variant="outline" data-restore-open @click="load">{{ t('dataFormat.restore.open') }}</Button>
        </div>
        <GrowthLoading v-else-if="loading" variant="compact" :label="t('dataFormat.restore.loading')" />
        <p v-else-if="loadError" class="store-restore-error" role="alert">{{ t('dataFormat.restore.loadFailed') }} {{ loadError }}</p>
        <p v-else-if="!options.length">{{ t('dataFormat.restore.none') }}</p>
        <template v-else>
          <span id="store-restore-choose" class="store-restore-label">{{ t('dataFormat.restore.choose') }}</span>
          <RadioGroup :model-value="choice" aria-labelledby="store-restore-choose" class="grid gap-2"
            :disabled="describing || starting" @update:model-value="choose">
            <label v-for="option in options" :key="option.value" class="store-restore-option" data-restore-backup>
              <RadioGroupItem :value="option.value" />
              <span>{{ option.text }}</span>
            </label>
          </RadioGroup>
          <div v-if="choice && !impact">
            <Button variant="outline" data-restore-describe :loading="describing"
              :loading-label="t('dataFormat.restore.describing', { label: chosen.label })" @click="describe">
              {{ t('dataFormat.restore.describe') }}
            </Button>
          </div>
          <div v-if="impact" class="store-restore-impact" data-restore-impact>
            <p class="store-restore-loss">{{ t('dataFormat.restore.loss', { label: chosen.label, time: time(impact.takenAt) }) }}</p>
            <ul>
              <li>{{ t('dataFormat.restore.versions', { current: impact.currentVersion ?? '-', backup: impact.backupVersion ?? '-' }) }}</li>
              <li v-for="table in impact.tables ?? []" :key="table.table">{{ t('dataFormat.restore.table', table) }}</li>
              <li v-for="entry in impact.laterMigrations" :key="entry.migrationId">
                {{ t('dataFormat.restore.later', { id: entry.migrationId, status: entry.status }) }}
              </li>
            </ul>
            <div class="store-restore-check">
              <Checkbox id="store-restore-understood" v-model="understood" :disabled="starting" />
              <Label for="store-restore-understood">{{ t('dataFormat.restore.understand', { label: chosen.label }) }}</Label>
            </div>
            <div class="store-restore-actions">
              <Button variant="destructive" data-restore-confirm :disabled="!understood" :loading="starting"
                :loading-label="t('dataFormat.restore.running', { label: chosen.label })" @click="confirm">
                {{ t('dataFormat.restore.confirm') }}
              </Button>
              <Button variant="ghost" :disabled="starting" @click="choose('')">{{ t('dataFormat.restore.cancel') }}</Button>
            </div>
          </div>
        </template>
      </template>
      <p v-if="error" class="store-restore-error" role="alert">{{ error }}</p>
    </div>
  </Card>
</template>

<style scoped>
.store-restore-body {
  display: grid;
  gap: 16px;
  padding-inline: 20px;
  font-size: 14px;
}

.store-restore-body p { margin: 0; }
.store-restore-label { color: var(--color-muted); font-size: 13px; }

.store-restore-option,
.store-restore-check {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  overflow-wrap: anywhere;
}

.store-restore-impact {
  display: grid;
  gap: 12px;
}

.store-restore-impact ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 18px;
  color: var(--color-muted);
  font-size: 13.5px;
}

.store-restore-loss,
.store-restore-error { color: var(--color-danger); }

.store-restore-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
