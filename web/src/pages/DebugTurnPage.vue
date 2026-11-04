<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import DebugTurnPart from '@/features/debug-turns/DebugTurnPart.vue'
import {
  clientName, DEBUG_SOURCES, deleteDebugTurn, fuliShare, readDebugTurn, sourceColour, type DebugTurnRecord,
} from '@/features/debug-turns/model'
import { currentLocale, t } from '@/i18n'
import { usePageTitle } from '@/layouts/page-title'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { UiDialog, UiEmpty, UiNotice } from '@/ui'

// One #debug turn record: its parts in order, each coloured by its source,
// and how much of the turn FULI added.
const route = useRoute()
const router = useRouter()
const record = ref<DebugTurnRecord | null>(null)
const loading = ref(true)
const error = ref('')
const missing = ref(false)
const confirming = ref(false)
const removing = ref(false)
const removeError = ref('')
let reading: AbortController | null = null
const openedFromList = /^\/debug(?:[?#]|$)/

const id = computed(() => String(route.params.id ?? ''))
const share = computed(() => record.value ? fuliShare(record.value.totals) : null)
const pageName = computed(() => record.value
  ? `${formatDateTime(record.value.createdAt, currentLocale(), DATE_TIME_MINUTE, { missing: '' })} · ${clientName(record.value.sourceApplication)}`
  : '')
usePageTitle(pageName)

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  error.value = ''
  missing.value = false
  try {
    record.value = await readDebugTurn(id.value, reading.signal)
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') return
    if (apiErrorCode(cause) === 'debug_turn_not_found') missing.value = true
    else error.value = t('debugTurns.loadFailed', { reason: apiErrorReason(cause) })
  } finally {
    loading.value = false
  }
}

async function remove() {
  if (removing.value) return
  removing.value = true
  removeError.value = ''
  try {
    await deleteDebugTurn(id.value)
    confirming.value = false
    await router.replace('/debug')
  } catch (cause) {
    removeError.value = t('debugTurns.removeFailed', { reason: apiErrorReason(cause) })
  } finally {
    removing.value = false
  }
}

watch(id, load, { immediate: true })
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section class="view debug-turn-view" :aria-label="t('debugTurns.title')">
    <div class="debug-turn-content">
      <div class="debug-turn-bar">
        <Breadcrumb :parent="{ label: t('debugTurns.title'), to: '/debug', from: openedFromList }" :current="pageName || undefined" />
        <Button v-if="record" type="button" size="sm" variant="outline" data-debug-turn-remove @click="confirming = true">
          {{ t('debugTurns.remove') }}
        </Button>
      </div>
      <GrowthLoading v-if="loading && !record" :label="t('debugTurns.loadingRecord')" />
      <UiEmpty v-else-if="missing" :text="t('debugTurns.notFound')" />
      <UiNotice v-else-if="error" tone="error">
        {{ error }}
        <template #actions><Button variant="outline" size="sm" @click="load">{{ t('debugTurns.retry') }}</Button></template>
      </UiNotice>
      <template v-else-if="record && share">
        <p class="debug-turn-share" data-debug-turn-share>
          {{ t('debugTurns.fuliAdded', { size: formatBytes(share.bytes), total: formatBytes(share.total), percent: share.percent }) }}
        </p>
        <ul class="debug-turn-legend" :aria-label="t('debugTurns.legend')" data-debug-turn-legend>
          <li v-for="source in DEBUG_SOURCES" :key="source" :data-source="source">
            <span class="debug-turn-swatch" :style="{ background: sourceColour(source) }" aria-hidden="true" />
            {{ t(`debugTurns.sources.${source}`) }}
            <small>{{ formatBytes(record.totals[source]) }}</small>
          </li>
        </ul>
        <UiNotice v-if="record.cut?.historyMessages" tone="warning">
          {{ t('debugTurns.historyCut', { count: record.cut.historyMessages, size: formatBytes(record.cut.historyBytes) }) }}
        </UiNotice>
        <UiNotice v-if="record.cut?.parts.length" tone="warning">{{ t('debugTurns.partsCut', { count: record.cut.parts.length }) }}</UiNotice>
        <div class="debug-turn-parts">
          <DebugTurnPart v-for="(part, index) in record.parts" :key="index" :part="part" />
        </div>
      </template>
    </div>
    <UiDialog :open="confirming" :title="t('debugTurns.remove')" size="sm" :busy="removing" :error="removeError" @close="confirming = false">
      <p>{{ t('debugTurns.removeConfirm') }}</p>
      <template #footer>
        <Button variant="outline" :disabled="removing" @click="confirming = false">{{ t('common.actions.cancel') }}</Button>
        <Button variant="destructive" :loading="removing" :loading-label="t('debugTurns.removing')" data-debug-turn-remove-confirm @click="remove">
          {{ t('debugTurns.remove') }}
        </Button>
      </template>
    </UiDialog>
  </section>
</template>

<style scoped>
.debug-turn-view { padding-bottom: 96px; color: var(--color-ink); }
.debug-turn-content { width: 100%; min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.debug-turn-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.debug-turn-share { margin: 0; font-size: var(--text-body); font-weight: var(--weight-medium); }
.debug-turn-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0; padding: 0; list-style: none; font-size: var(--text-meta); }
.debug-turn-legend li { display: inline-flex; align-items: center; gap: 6px; }
.debug-turn-legend small { color: var(--color-muted); font-size: var(--text-meta); }
.debug-turn-swatch { width: 10px; height: 10px; border-radius: var(--radius-pill); }
.debug-turn-parts { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
</style>
