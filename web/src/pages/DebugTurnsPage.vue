<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiErrorReason } from '@/api/client'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { clientName, fuliShare, listDebugTurns, type DebugTurnSummary } from '@/features/debug-turns/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { UiEmpty, UiNotice } from '@/ui'

// 调试记录: every #debug turn record on this computer, newest first.
const records = ref<DebugTurnSummary[] | null>(null)
const loading = ref(true)
const error = ref('')
let reading: AbortController | null = null
const openedFromSettings = /^\/settings(?:[?#]|$)/

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  error.value = ''
  try {
    records.value = await listDebugTurns(reading.signal)
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') error.value = t('debugTurns.loadFailed', { reason: apiErrorReason(cause) })
  } finally {
    loading.value = false
  }
}

const when = (value: string) => formatDateTime(value, currentLocale(), DATE_TIME_MINUTE, { missing: '' })
function added(record: DebugTurnSummary) {
  const share = fuliShare(record.totals)
  return t('debugTurns.fuliAdded', { size: formatBytes(share.bytes), total: formatBytes(share.total), percent: share.percent })
}

onMounted(load)
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section class="view debug-turns-view" :aria-label="t('debugTurns.title')">
    <div class="debug-turns-content">
      <Breadcrumb :parent="{ label: t('debugTurns.back'), to: '/settings', from: openedFromSettings }" />
      <p class="debug-turns-lede">{{ t('debugTurns.lede') }}</p>
      <GrowthLoading v-if="loading && !records" :label="t('debugTurns.loading')" />
      <UiNotice v-else-if="error" tone="error">
        {{ error }}
        <template #actions><Button variant="outline" size="sm" @click="load">{{ t('debugTurns.retry') }}</Button></template>
      </UiNotice>
      <UiEmpty v-else-if="records && !records.length" :text="t('debugTurns.empty')" />
      <Card v-else-if="records" as="section" class="debug-turns-card">
        <ul class="debug-turns-list">
          <li v-for="record in records" :key="record.id">
            <RouterLink :to="`/settings/debug-turns/${encodeURIComponent(record.id)}`" class="debug-turns-row"
              :data-return-focus="record.id" data-debug-turn-row>
              <span class="debug-turns-prompt">{{ record.promptLine }}</span>
              <span class="debug-turns-meta">{{ when(record.createdAt) }} · {{ clientName(record.sourceApplication) }} · {{ added(record) }}</span>
            </RouterLink>
          </li>
        </ul>
      </Card>
    </div>
  </section>
</template>

<style scoped>
.debug-turns-view { padding-bottom: 96px; color: var(--color-ink); }
.debug-turns-content { width: 100%; display: grid; gap: 16px; }
.debug-turns-lede { max-width: var(--measure); margin: 0; color: var(--color-muted); font-size: var(--text-body); line-height: 1.6; }
.debug-turns-list { display: grid; margin: 0; padding: 0; list-style: none; }
.debug-turns-list li + li { border-top: 1px solid var(--color-border); }
.debug-turns-row { display: grid; gap: 2px; padding: 10px 24px; color: inherit; text-decoration: none; user-select: none; }
.debug-turns-row:hover { background: var(--color-surface-hover); }
.debug-turns-prompt { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.debug-turns-meta { color: var(--color-muted); font-size: var(--text-meta); }
</style>
