<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { OptionSelect } from '@/components/ui/select'
import { t } from '@/i18n'
import UiNotice from '@/ui/UiNotice.vue'
import type { Format } from './client-connection-model'

// Settings › 客户端's manual card: the MCP configuration to paste into a
// client by hand. A client FULI should write and keep current itself is
// added in the status card instead (ClientConnectionSettings.vue).
const GUIDE_URL = 'https://github.com/JevonsCode/fuli/blob/main/docs/client-connections.md'

const configuration = ref<Record<Format, object> | null>(null)
const format = ref<Format>('standard')
const loading = ref(false)
const error = ref('')
const feedback = ref<'copied' | 'manual' | ''>('')
const text = computed(() => configuration.value ? JSON.stringify(configuration.value[format.value], null, 2) : '')
const options = computed(() => (['standard', 'vscode', 'server'] as const).map((value) => ({
  value, label: t(`settings.connection.formats.${value}`),
})))

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { configuration.value = await getJson<Record<Format, object>>('/api/system/client-connection') }
  catch { error.value = t('settings.connection.loadError') }
  finally { loading.value = false }
}
onMounted(() => { void load() })

function select(value: string) {
  if (value === 'standard' || value === 'vscode' || value === 'server') {
    format.value = value
    feedback.value = ''
  }
}
async function copy() {
  const selected = text.value
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
    await navigator.clipboard.writeText(selected)
    if (text.value === selected) feedback.value = 'copied'
  } catch { if (text.value === selected) feedback.value = 'manual' }
}
</script>

<template>
  <Card as="section" id="manual-connection" class="settings-card connection-settings" aria-labelledby="client-connection-manual" data-client-manual-connection>
    <CardHeader>
      <CardTitle id="client-connection-manual" as="h2">{{ t('settings.connection.custom.title') }}</CardTitle>
    </CardHeader>
    <div class="connection-sections">
      <div class="connection-section">
        <GrowthLoading v-if="loading" variant="compact" :label="t('settings.connection.loading')" />
        <UiNotice v-if="error" tone="error">
          {{ error }}
          <template #actions><Button size="sm" variant="outline" data-retry-connection @click="load">{{ t('settings.connection.retry') }}</Button></template>
        </UiNotice>
        <template v-if="configuration">
          <div class="connection-toolbar">
            <OptionSelect control-id="client-connection-format" :model-value="format" :options="options"
              :label="t('settings.connection.format')" @update:model-value="select" />
            <Button variant="outline" size="icon" class="connection-copy" data-copy-connection
              :title="t('settings.connection.copy')" :aria-label="t('settings.connection.copy')" @click="copy">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
            </Button>
          </div>
          <textarea :value="text" readonly rows="8" spellcheck="false" :aria-label="t('settings.connection.configuration')" />
          <p v-if="feedback" role="status">{{ t(`settings.connection.${feedback}`) }}</p>
          <p>{{ t('settings.connection.merge') }} {{ t('settings.connection.boundary') }}
            <a :href="GUIDE_URL" target="_blank" rel="noopener noreferrer">{{ t('settings.connection.guide') }}</a></p>
        </template>
      </div>
    </div>
  </Card>
</template>

<style src="./client-tiles.css" />

<style scoped>
.connection-settings p { color: var(--color-muted); font-size: 13px; line-height: 1.6; }
.connection-settings a { font-size: 13px; }
/* The format select and its copy button share one control height. */
.connection-toolbar { display: flex; align-items: flex-end; gap: 8px; }
.connection-toolbar :deep([data-slot=option-select]) { min-width: 0; flex: 0 1 300px; }
.connection-copy svg { width: 18px; height: 18px; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; font: 12px/1.65 var(--font-mono, monospace); overflow-wrap: anywhere; }
</style>
