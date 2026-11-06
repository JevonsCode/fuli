<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { t } from '@/i18n'
import { readModelCapture, setModelCapture } from './model'

// The hidden switch for reading what a model really receives.
const on = ref(false)
const port = ref(8788)
const busy = ref(false)
const error = ref('')
const command = computed(() => {
  const url = `http://127.0.0.1:${port.value}`
  return navigator.userAgent.includes('Windows') ? `$env:ANTHROPIC_BASE_URL='${url}'; claude` : `ANTHROPIC_BASE_URL=${url} claude`
})

onMounted(async () => {
  const status = await readModelCapture().catch(() => null)
  if (status) { on.value = status.on; port.value = status.port }
})

function copyCommand() { void navigator.clipboard.writeText(command.value) }

async function toggle(next: boolean) {
  busy.value = true
  error.value = ''
  try {
    const status = await setModelCapture(next)
    on.value = status.on
    port.value = status.port
  } catch (cause) {
    error.value = apiErrorCode(cause) === 'capture_port_in_use'
      ? t('debugTurns.capture.portBusy', { port: port.value }) : t('debugTurns.capture.failed', { reason: apiErrorReason(cause) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Card as="section" class="model-capture" data-model-capture>
    <div class="model-capture-head">
      <strong>{{ t('debugTurns.capture.title') }}</strong>
      <Switch :model-value="on" :disabled="busy" :aria-label="t('debugTurns.capture.title')" data-model-capture-switch @update:model-value="toggle" />
    </div>
    <template v-if="on">
      <p>{{ t('debugTurns.capture.hint') }}</p>
      <div class="model-capture-command">
        <code data-model-capture-command>{{ command }}</code>
        <Button variant="outline" size="sm" @click="copyCommand">{{ t('debugTurns.capture.copyCommand') }}</Button>
      </div>
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
  </Card>
</template>

<style scoped>
.model-capture { display: grid; gap: 8px; padding: 12px 24px; }
.model-capture-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.model-capture p { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.model-capture-command { display: flex; align-items: center; gap: 8px; min-width: 0; }
.model-capture-command code { flex: 1; min-width: 0; overflow: auto; font-family: var(--font-mono, monospace); font-size: var(--text-meta); white-space: nowrap; }
</style>
