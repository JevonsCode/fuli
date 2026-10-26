<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { t } from '@/i18n'
import { readConsoleUpdate, startConsoleUpdate, updateFinished, type ConsoleUpdateStatus } from './model'

// 「更新到 vX」 in the update notice: one click starts the same update the
// command runs. FULI stops while it installs, so a failed read is expected;
// the page reloads once the new version answers.
const POLL_MS = 3000
const GIVE_UP_MS = 15 * 60_000

const props = withDefaults(defineProps<{ version: string; offered?: boolean; reload?: () => void }>(), {
  offered: true, reload: () => window.location.reload(),
})
const emit = defineEmits<{ busy: [busy: boolean] }>()
const running = ref(false)
const outcome = ref<ConsoleUpdateStatus | null>(null)
const notBack = ref(false)
const error = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

function busy(value: boolean) {
  running.value = value
  emit('busy', value)
}

async function start() {
  error.value = ''
  outcome.value = null
  notBack.value = false
  busy(true)
  let started: ConsoleUpdateStatus
  try {
    started = await startConsoleUpdate()
  } catch (cause) {
    error.value = apiErrorReason(cause)
    busy(false)
    return
  }
  const deadline = Date.now() + GIVE_UP_MS
  const ask = async () => {
    if (unmounted) return
    let latest: ConsoleUpdateStatus | null = null
    try { latest = (await readConsoleUpdate()).update } catch { /* FULI is stopped while it installs */ }
    if (unmounted) return
    if (updateFinished(latest, started.id)) {
      if (latest.status === 'updated') { props.reload(); return }
      outcome.value = latest
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
    <template v-if="offered">
      <p>{{ t('console.update.copy') }}</p>
      <GrowthLoading v-if="running" variant="inline" :label="t('console.update.running', { version })" />
      <Button v-else size="sm" data-console-update-start @click="start">{{ t('console.update.action', { version }) }}</Button>
      <p v-if="outcome?.status === 'unchanged'" role="status">{{ t('console.update.unchanged') }}</p>
      <p v-if="outcome?.status === 'failed'" role="alert" class="console-update-error">
        {{ t('console.update.failed', { reason: outcome.error ?? '' }) }}
      </p>
      <p v-if="notBack" role="alert" class="console-update-error">{{ t('console.update.notBack') }}</p>
      <p v-if="error" role="alert" class="console-update-error">{{ error }}</p>
    </template>
    <p v-else>{{ t('console.update.installer') }}</p>
  </div>
</template>

<style scoped>
.console-update { display: grid; gap: 8px; justify-items: start; margin-top: 5px; }
.console-update p { margin: 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.console-update-error { color: var(--color-danger) !important; }
</style>
