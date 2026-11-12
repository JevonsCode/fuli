<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { deleteJson, getJson, postJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import TextField from '@/components/TextField.vue'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardHeader, CardTitle } from '@/components/ui/card'
import { OptionSelect } from '@/components/ui/select'
import { t } from '@/i18n'
import UiIcon from '@/ui/UiIcon.vue'
import UiNotice from '@/ui/UiNotice.vue'
import { injectClientConnectionStatus } from './client-connection-status'
import { CUSTOM_CLIENT_FORMATS, STATUS_MARKS, type CustomClient, type CustomClientFormat, type Format } from './client-connection-model'

// Settings › 客户端's manual card: a client FULI does not know, described by
// hand, and the MCP configuration to paste into any other client. Its writes
// read the clients' status again, so the status card's summary follows.
const GUIDE_URL = 'https://github.com/JevonsCode/fuli/blob/main/docs/client-connections.md'

const { observation, busy, writing } = injectClientConnectionStatus()
const configuration = ref<Record<Format, object> | null>(null)
const format = ref<Format>('standard')
const loading = ref(false)
const error = ref('')
const feedback = ref<'copied' | 'manual' | ''>('')
const adding = ref(false)
const addPending = ref(false)
const addError = ref('')
const removing = ref('')
const removeError = ref('')
const draft = reactive<{ name: string, mcpFile: string, format: CustomClientFormat }>({ name: '', mcpFile: '', format: 'mcp-servers-json' })
const text = computed(() => configuration.value ? JSON.stringify(configuration.value[format.value], null, 2) : '')
const options = computed(() => (['standard', 'vscode', 'server'] as const).map((value) => ({
  value, label: t(`settings.connection.formats.${value}`),
})))
const formatOptions = computed(() => CUSTOM_CLIENT_FORMATS.map((value) => ({ value, label: t(`settings.connection.custom.formats.${value}`) })))
const customClients = computed<CustomClient[]>(() => observation.value?.customClients ?? [])

async function load() {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try { configuration.value = await getJson<Record<Format, object>>('/api/system/client-connection') }
  catch { error.value = t('settings.connection.loadError') }
  finally { loading.value = false }
}
onMounted(() => { void load() })

async function addClient() {
  if (busy.value || !draft.name.trim() || !draft.mcpFile.trim()) return
  addPending.value = true
  addError.value = ''
  await writing(async () => {
    try {
      await postJson('/api/system/client-connection/custom-clients', { name: draft.name.trim(), mcpFile: draft.mcpFile.trim(), format: draft.format })
      Object.assign(draft, { name: '', mcpFile: '', format: 'mcp-servers-json' })
      adding.value = false
    } catch (reason) {
      addError.value = t('settings.connection.custom.addError', { reason: reason instanceof Error ? reason.message : String(reason) })
    } finally { addPending.value = false }
  })
}
async function removeClient(client: CustomClient) {
  if (busy.value) return
  removing.value = client.id
  removeError.value = ''
  await writing(async () => {
    try { await deleteJson(`/api/system/client-connection/custom-clients/${encodeURIComponent(client.id)}`) }
    catch { removeError.value = t('settings.connection.custom.removeError') }
    finally { removing.value = '' }
  })
}
function select(value: string) {
  if (value === 'standard' || value === 'vscode' || value === 'server') {
    format.value = value
    feedback.value = ''
  }
}
function selectFormat(value: string) {
  const known = CUSTOM_CLIENT_FORMATS.find((candidate) => candidate === value)
  if (known) draft.format = known
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
      <!-- The add button keeps its place: the form opens below it. -->
      <CardAction>
        <Button v-if="!adding" size="sm" variant="outline" data-add-custom-client :disabled="observation?.available === false"
          @click="adding = true">{{ t('settings.connection.custom.add') }}</Button>
      </CardAction>
    </CardHeader>
    <div class="connection-sections">
      <div class="connection-section">
        <form v-if="adding" class="custom-form" data-custom-client-form @submit.prevent="addClient">
          <TextField v-model="draft.name" control-id="custom-client-name" :label="t('settings.connection.custom.name')"
            :placeholder="t('settings.connection.custom.namePlaceholder')" required />
          <TextField v-model="draft.mcpFile" control-id="custom-client-file" :label="t('settings.connection.custom.mcpFile')"
            placeholder="~/.acme/mcp.json" required />
          <OptionSelect control-id="custom-client-format" :model-value="draft.format" :options="formatOptions"
            :label="t('settings.connection.custom.format')" @update:model-value="selectFormat" />
          <div class="custom-form__actions">
            <Button type="submit" size="sm" data-submit-custom-client :disabled="busy || !draft.name.trim() || !draft.mcpFile.trim()"
              :loading="addPending" :loading-label="t('settings.connection.custom.adding', { client: draft.name.trim() })">
              {{ t('settings.connection.custom.submit') }}
            </Button>
            <Button type="button" size="sm" variant="ghost" :disabled="addPending" @click="adding = false; addError = ''">
              {{ t('settings.connection.custom.cancel') }}
            </Button>
          </div>
          <UiNotice v-if="addError" tone="error">{{ addError }}</UiNotice>
        </form>
        <ul v-if="customClients.length" class="client-grid">
          <li v-for="client in customClients" :key="client.id" :data-custom-client="client.id" :data-client-status="client.status"
            :class="`client-row client-row--${client.status}`">
            <span class="client-row__icon" aria-hidden="true"><UiIcon v-if="client.status === 'connected'" name="check" :size="14" /><template v-else>{{ STATUS_MARKS[client.status] }}</template></span>
            <div class="client-row__body">
              <div class="client-row__head">
                <strong>{{ client.label }}</strong>
                <span class="client-row__label">{{ t(`settings.connection.clients.status.${client.status}`) }}</span>
                <Button v-if="client.removable" size="icon-sm" variant="ghost" class="client-row__action" :data-remove-custom-client="client.id"
                  :disabled="busy" :loading="removing === client.id" :loading-label="t('settings.connection.custom.removing', { client: client.label })"
                  :title="t('settings.connection.custom.remove', { client: client.label })"
                  :aria-label="t('settings.connection.custom.remove', { client: client.label })" @click="removeClient(client)">
                  <UiIcon name="close" :size="14" />
                </Button>
              </div>
              <p v-for="path in client.mcpPaths" :key="path">
                {{ t('settings.connection.custom.where', { path }) }}
              </p>
            </div>
          </li>
        </ul>
        <UiNotice v-if="removeError" tone="error">{{ removeError }}</UiNotice>

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
.custom-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; align-items: end; padding: 14px; border-radius: var(--radius-card); box-shadow: 0 0 0 1px var(--color-border); }
.custom-form__actions { display: flex; gap: 8px; }
.custom-form > :deep(.ui-notice) { grid-column: 1 / -1; }
/* The format select and its copy button share one control height. */
.connection-toolbar { display: flex; align-items: flex-end; gap: 8px; }
.connection-toolbar :deep([data-slot=option-select]) { min-width: 0; flex: 0 1 300px; }
.connection-copy svg { width: 18px; height: 18px; }
textarea { display: block; box-sizing: border-box; width: 100%; min-width: 0; resize: vertical; font: 12px/1.65 var(--font-mono, monospace); overflow-wrap: anywhere; }
</style>
