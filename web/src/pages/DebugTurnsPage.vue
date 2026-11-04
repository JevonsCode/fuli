<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { apiErrorReason } from '@/api/client'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { clientName, deleteDebugTurns, fuliShare, listDebugTurns, type DebugTurnSummary } from '@/features/debug-turns/model'
import { currentLocale, t } from '@/i18n'
import { DATE_TIME_MINUTE, formatDateTime } from '@/lib/date-time'
import { formatBytes } from '@/lib/format-bytes'
import { useConsoleStore } from '@/stores/console'
import { UiEmpty, UiNotice } from '@/ui'

// 调试记录: every #debug turn record on this computer, newest first, reached by
// holding the settings button. Deleting asks once more in place: it cannot be undone.
const store = useConsoleStore()
const records = ref<DebugTurnSummary[] | null>(null)
const loading = ref(true)
const error = ref('')
let reading: AbortController | null = null
const openedFromSettings = /^\/settings(?:[?#]|$)/
const selected = ref(new Set<string>())
const confirming = ref(false)
const removing = ref(false)
const allSelected = computed(() => Boolean(records.value?.length) && selected.value.size === records.value?.length)

function choose(next: Set<string>) {
  selected.value = next
  confirming.value = false
}
function toggle(id: string) {
  const next = new Set(selected.value)
  if (!next.delete(id)) next.add(id)
  choose(next)
}
const toggleAll = () => choose(new Set(allSelected.value ? [] : records.value?.map(record => record.id)))

async function removeSelected() {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  removing.value = true
  try {
    const { deleted } = await deleteDebugTurns([...selected.value])
    store.notify(t('debugTurns.removedSelected', { count: deleted.length }))
    choose(new Set())
    await load()
  } catch (cause) {
    store.reportError(cause)
  } finally {
    removing.value = false
  }
}

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
        <div class="debug-turns-tools">
          <label class="debug-turns-all"><Checkbox :model-value="allSelected" data-debug-turn-all @update:model-value="toggleAll" />{{ t('debugTurns.selectAll') }}</label>
          <Button v-if="selected.size" size="sm" :variant="confirming ? 'destructive' : 'outline'" :loading="removing"
            :loading-label="t('debugTurns.removingSelected')" data-debug-turn-delete @click="removeSelected">
            {{ t(confirming ? 'debugTurns.confirmSelected' : 'debugTurns.removeSelected', { count: selected.size }) }}
          </Button>
        </div>
        <ul class="debug-turns-list">
          <li v-for="record in records" :key="record.id" class="debug-turns-item">
            <Checkbox :model-value="selected.has(record.id)" :aria-label="t('debugTurns.selectOne')" data-debug-turn-select @update:model-value="toggle(record.id)" />
            <RouterLink :to="`/debug/${encodeURIComponent(record.id)}`" class="debug-turns-row"
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
.debug-turns-list { display: grid; gap: 2px; margin: 0; padding: 0 8px 8px; list-style: none; }
.debug-turns-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 0 24px; }
.debug-turns-all { display: flex; align-items: center; gap: 12px; color: var(--color-muted); font-size: var(--text-meta); cursor: pointer; user-select: none; }
/* The whole row lifts, checkbox included, inside the card's edges. */
.debug-turns-item { display: flex; align-items: center; gap: 12px; padding-left: 16px; border-radius: var(--radius-control); transition: background-color var(--motion-fast) var(--motion-ease); }
.debug-turns-item:hover { background: var(--color-surface-hover); }
.debug-turns-row { display: grid; flex: 1; min-width: 0; gap: 2px; padding: 10px 16px 10px 0; color: inherit; text-decoration: none; user-select: none; }
.debug-turns-prompt { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.debug-turns-meta { color: var(--color-muted); font-size: var(--text-meta); }
</style>
