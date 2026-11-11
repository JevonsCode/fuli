<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import PageColumns from '@/components/PageColumns.vue'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import AiHelpButton from '@/features/ai-help/AiHelpButton.vue'
import CaptureProjectSettings from '@/features/capture/CaptureProjectSettings.vue'
import { clientDetectionShape, shownCaptureClients, type ClientDetection } from '@/features/capture/capture-clients'
import { captureSourceOff, withCaptureSource } from '@/features/capture/capture-sources'
import { t } from '@/i18n'
import { usePageRefresh } from '@/layouts/page-refresh'
import { useConsoleStore } from '@/stores/console'
import type { RuntimeSettings } from '@/types'

// Settings › 记录: what FULI writes down: each client's capture, each
// project's, and whether a recurring topic becomes a project by itself.
// The page's one autosaved form: each tab edits its own fields in place.
const form = defineModel<RuntimeSettings>('form', { required: true })

const store = useConsoleStore()
const captureEnabled = computed(() => store.state?.capturePolicy?.enabled !== false)
// Capture is per client; a client that is off still reads memory through its tools.
const captureSources = computed(() => store.state?.capturePolicy ?? {})
// The switches list the clients on this machine; a failed read keeps the full list.
const clientDetection = ref<ClientDetection | null>(null)
const detectingClients = ref(true)
const captureClients = computed(() => shownCaptureClients(clientDetection.value, captureSources.value))
const reading = new AbortController()

async function detectClients() {
  try { clientDetection.value = await getJson('/api/system/client-connection/status', clientDetectionShape, { signal: reading.signal }) }
  catch { clientDetection.value = null }
  finally { detectingClients.value = false }
}

function toggleClientCapture(source: string, capture: boolean) {
  void store.updateCapturePolicy(captureEnabled.value, withCaptureSource(captureSources.value, source, capture))
}

function toggleCapture(enabled: boolean) {
  void store.updateCapturePolicy(enabled)
}

onMounted(() => { void detectClients() })
onBeforeUnmount(() => reading.abort())
// The top bar's 刷新 looks for the clients on this machine again.
usePageRefresh(detectClients)
</script>

<template>
  <PageColumns>
    <Card as="section" class="settings-card behavior-card" aria-labelledby="settings-capture-title">
      <CardHeader><CardTitle id="settings-capture-title" as="h2">{{ t('settings.groups.capture') }}<AiHelpButton term="task.capture" /></CardTitle></CardHeader>
      <div class="setting-list">
        <label class="setting-row">
          <span><strong>{{ t('settings.behavior.capture') }}</strong><small>{{ t('settings.behavior.captureMeta') }}</small></span>
          <Switch :model-value="captureEnabled" :aria-label="t('settings.behavior.capture')" @update:model-value="toggleCapture" />
        </label>
        <template v-if="captureEnabled && (detectingClients || captureClients.length)">
          <p class="setting-note">{{ t('settings.behavior.captureClientsMeta') }}</p>
          <GrowthLoading v-if="detectingClients" variant="inline" class="setting-note" :label="t('settings.behavior.captureClientsLoading')" />
          <template v-else>
            <label v-for="[source, label] in captureClients" :key="source" class="setting-row setting-row-nested" :data-capture-source="source">
              <span><strong>{{ label }}</strong></span>
              <Switch :model-value="!captureSourceOff(captureSources, source)" :aria-label="label" @update:model-value="toggleClientCapture(source, $event)" />
            </label>
          </template>
        </template>
      </div>
    </Card>
    <Card as="section" class="settings-card" aria-labelledby="settings-capture-projects-title" data-capture-projects-card>
      <CardHeader>
        <CardTitle id="settings-capture-projects-title" as="h2">{{ t('capture.settings.title') }}<AiHelpButton term="task.captureProjects" /></CardTitle>
        <CardDescription>{{ t('capture.settings.description') }}</CardDescription>
      </CardHeader>
      <CaptureProjectSettings class="px-5" />
    </Card>
    <Card v-if="form.topicPromotion !== undefined" as="section" class="settings-card" aria-labelledby="settings-topic-promotion-title" data-topic-promotion-card>
      <div class="setting-list">
        <label class="setting-row">
          <span><strong id="settings-topic-promotion-title">{{ t('settings.topicPromotion.title') }}</strong><small>{{ t('settings.topicPromotion.description') }}</small></span>
          <Switch :model-value="form.topicPromotion === 'auto'" :aria-label="t('settings.topicPromotion.title')"
            data-settings-field="topicPromotion" @update:model-value="form.topicPromotion = $event ? 'auto' : 'ask'" />
        </label>
      </div>
    </Card>
  </PageColumns>
</template>
