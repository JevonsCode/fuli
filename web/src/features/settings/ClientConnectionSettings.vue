<script setup lang="ts">
import { computed, ref } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { t } from '@/i18n'

type Format = 'standard' | 'vscode' | 'server'
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
function opened(event: Event) {
  if ((event.target as HTMLDetailsElement).open && !configuration.value && !loading.value && !error.value) void load()
}
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
  <UiDisclosure class="settings-card connection-settings" :title="t('settings.connection.title')" @toggle="opened">
    <p>{{ t('settings.connection.description') }}</p>
    <GrowthLoading v-if="loading" variant="compact" :label="t('settings.connection.loading')" />
    <div v-if="error" role="alert">
      <span>{{ error }}</span>
      <button class="ui-button" type="button" data-retry-connection @click="load">{{ t('settings.connection.retry') }}</button>
    </div>
    <template v-if="configuration">
      <div class="connection-toolbar">
        <UiSelect control-id="client-connection-format" :model-value="format" :options="options"
          :label="t('settings.connection.format')" @update:model-value="select" />
        <button class="ui-button connection-copy" type="button" data-copy-connection
          :title="t('settings.connection.copy')" :aria-label="t('settings.connection.copy')" @click="copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></svg>
        </button>
      </div>
      <textarea :value="text" readonly rows="8" spellcheck="false" :aria-label="t('settings.connection.configuration')" />
      <p v-if="feedback" role="status">{{ t(`settings.connection.${feedback}`) }}</p>
      <p>{{ t('settings.connection.merge') }}</p>
    </template>
    <p class="connection-boundary">{{ t('settings.connection.boundary') }}</p>
    <a href="https://github.com/JevonsCode/fuli/blob/main/docs/client-connections.md" target="_blank" rel="noopener noreferrer">{{ t('settings.connection.guide') }}</a>
  </UiDisclosure>
</template>

<style scoped>
.connection-settings p { color: var(--color-muted); font-size: 13px; line-height: 1.6; margin: 12px 0; }
.connection-toolbar { display: flex; align-items: center; gap: 12px; margin: 16px 0 10px; }
.connection-toolbar :deep(.ui-select) { min-width: 0; flex: 1; max-width: 300px; }
.connection-copy { width: 40px; height: 40px; flex: 0 0 40px; padding: 9px; }
.connection-copy svg { width: 20px; height: 20px; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; font: 12px/1.65 var(--font-mono, monospace); overflow-wrap: anywhere; }
.connection-settings a { font-size: 13px; }
</style>
