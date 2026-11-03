<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { t } from '@/i18n'
import {
  blockerKey, readConsoleUpdate, startConsoleUpdate, updateFinished,
  type ConsoleUpdateKind, type ConsoleUpdateStatus, type ConsoleUpdateStep,
} from './model'

// 「更新到 vX」 in the update notice: one click starts the update. FULI stops
// while it installs, so a failed read is expected; the page reloads once the
// new version answers. The Windows tray and the macOS app report each real
// step while the console still answers (download, verify, then closing the
// window and switching versions); the app's window opens again by itself. A
// failure is one Chinese line, by its reason code when the update names one;
// the recorded text opens in 「查看详情」.
const POLL_MS = 3000
const GIVE_UP_MS = 15 * 60_000

const props = withDefaults(defineProps<{ version: string; kind?: ConsoleUpdateKind; reload?: () => void }>(), {
  kind: 'npm', reload: () => window.location.reload(),
})
const emit = defineEmits<{ busy: [busy: boolean] }>()
const running = ref(false)
const step = ref<ConsoleUpdateStep | null>(null)
const outcome = ref<ConsoleUpdateStatus | null>(null)
const notBack = ref(false)
const error = ref('')
const detailsOpen = ref(false)
// The text 「查看详情」 shows: the recorded reason, or why the update could not start.
const details = ref('')
const REASONS = new Set(['not_installed', 'no_permission', 'download_failed', 'checksum_mismatch', 'start_failed',
  'rollback_failed'])
let timer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

const runningLabel = computed(() => step.value
  ? t(`console.update.${props.kind === 'macos-app' ? 'macSteps' : 'steps'}.${step.value}`, { version: props.version })
  : t('console.update.running', { version: props.version }))
const failure = computed(() => {
  const code = outcome.value?.errorCode
  return code && REASONS.has(code) ? t(`console.update.reasons.${code}`) : t('console.update.failed')
})
// One line for a failed or refused update: the reason in Chinese, the raw text behind 「查看详情」.
const alert = computed(() => outcome.value?.status === 'failed' ? failure.value : error.value)
const copy = computed(() => props.kind === 'macos-app' ? t('console.update.macCopy', { version: props.version })
  : props.kind === 'windows-tray' ? t('console.update.trayCopy', { version: props.version }) : t('console.update.copy'))
const blockers = computed(() => outcome.value?.status === 'failed' ? outcome.value.blockers ?? [] : [])

function busy(value: boolean) {
  running.value = value
  emit('busy', value)
}

async function start(stopProcesses: string[] = []) {
  error.value = ''
  details.value = ''
  outcome.value = null
  notBack.value = false
  step.value = null
  busy(true)
  let started: ConsoleUpdateStatus
  try {
    started = await startConsoleUpdate(stopProcesses)
  } catch (cause) {
    error.value = t('console.update.notStarted')
    details.value = apiErrorReason(cause)
    busy(false)
    return
  }
  const deadline = Date.now() + GIVE_UP_MS
  const ask = async () => {
    if (unmounted) return
    let latest: ConsoleUpdateStatus | null = null
    try { latest = (await readConsoleUpdate()).update } catch { /* FULI is stopped while it installs */ }
    if (unmounted) return
    if (latest?.id === started.id && latest.step) step.value = latest.step
    if (updateFinished(latest, started.id)) {
      if (latest.status === 'updated') { props.reload(); return }
      outcome.value = latest
      details.value = latest.error ?? ''
      busy(false)
      return
    }
    if (Date.now() >= deadline) {
      notBack.value = true
      busy(false)
      return
    }
    timer = setTimeout(ask, POLL_MS)
  }
  if (updateFinished(started, started.id)) void ask()
  else timer = setTimeout(ask, POLL_MS)
}

onBeforeUnmount(() => {
  unmounted = true
  clearTimeout(timer)
})
</script>

<template>
  <div class="console-update" data-console-update>
    <p>{{ copy }}</p>
    <GrowthLoading v-if="running" variant="inline" :label="runningLabel" />
    <Button v-else size="sm" data-console-update-start @click="start()">{{ t('console.update.action', { version }) }}</Button>
    <p v-if="outcome?.status === 'unchanged'" role="status">{{ t('console.update.unchanged') }}</p>
    <p v-if="alert" role="alert" class="console-update-error">
      {{ alert }}
      <Button v-if="details" variant="link" size="sm" class="console-update-details" data-console-update-details
        @click="detailsOpen = true">{{ t('common.actions.viewDetails') }}</Button>
    </p>
    <template v-if="blockers.length && !running">
      <p>{{ t('console.update.blockers') }}</p>
      <ul class="console-update-blockers" data-console-update-blockers>
        <li v-for="blocker in blockers" :key="blockerKey(blocker)">
          {{ t('console.update.blocker', { role: t(`console.update.roles.${blocker.role}`), pid: blocker.pid,
                                           program: blocker.executable ?? t('console.update.unknownProgram') }) }}
        </li>
      </ul>
      <Button size="sm" variant="destructive" data-console-update-stop-blockers @click="start(blockers.map(blockerKey))">
        {{ t('console.update.stopAndRetry') }}
      </Button>
    </template>
    <p v-if="notBack" role="alert" class="console-update-error">{{ t('console.update.notBack') }}</p>
    <Dialog v-model:open="detailsOpen">
      <DialogContent size="md" data-console-update-reason>
        <DialogHeader>
          <DialogTitle>{{ t('console.update.detailsTitle') }}</DialogTitle>
          <DialogDescription>{{ t('console.update.detailsCopy') }}</DialogDescription>
        </DialogHeader>
        <p class="console-update-reason">{{ details }}</p>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.console-update { display: grid; gap: 8px; justify-items: start; margin-top: 5px; }
.console-update p { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.console-update-blockers { margin: 0; padding-left: 16px; color: var(--color-muted); font-size: 12px; line-height: 1.5;
  overflow-wrap: anywhere; }
.console-update-error { color: var(--color-danger) !important; }
.console-update-details { height: auto; margin-left: 6px; padding: 0; border: 0; background: none; color: inherit; font: inherit;
  text-decoration: underline; text-underline-offset: 2px; cursor: pointer; user-select: none; }
.console-update-reason { margin: 0; color: var(--color-muted); font-family: var(--font-mono); font-size: 12px; line-height: 1.6;
  overflow-wrap: anywhere; }
</style>
