<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { currentLocale, t } from '@/i18n'
import { UiSegmented } from '@/ui'
import {
  USAGE_WINDOWS, costValue, readModelUsage, roleName, tokenValue, usageRows, usageText,
  type UsagePayload, type UsageRow, type UsageWindow,
} from './model'

// Usage from the ledger by role, model and time range. Model API calls and
// fallbacks to the current session are listed apart; an unreported value
// reads 未上报 with its count, never 0.
const range = ref<UsageWindow>('7d')
const payload = ref<UsagePayload | null>(null)
const loading = ref(false)
const error = ref('')
let reading: AbortController | null = null

const windowOptions = computed(() => USAGE_WINDOWS.map(value => ({ value, label: t(`modelSettings.usage.windows.${value}`) })))
const rows = computed(() => usageRows(payload.value?.groups ?? []))
const locale = computed(() => currentLocale())

async function load() {
  reading?.abort()
  reading = new AbortController()
  loading.value = true
  error.value = ''
  try {
    payload.value = await readModelUsage(range.value, reading.signal)
  } catch (cause) {
    if ((cause as Error)?.name !== 'AbortError') error.value = apiErrorReason(cause)
  } finally {
    loading.value = false
  }
}

const cells = (row: UsageRow) => {
  const { group } = row
  const cost = costValue(group)
  return [
    { key: 'input', label: t('modelSettings.usage.input'), text: usageText(tokenValue(group.tokens.input, group.attempts), locale.value) },
    { key: 'output', label: t('modelSettings.usage.output'), text: usageText(tokenValue(group.tokens.output, group.attempts), locale.value) },
    { key: 'cache', label: t('modelSettings.usage.cache'), text: usageText(tokenValue(group.tokens.cachedInput, group.attempts), locale.value) },
    ...(group.tokens.cacheWriteInput ? [{ key: 'cacheWrite', label: t('modelSettings.usage.cacheWrite'),
      text: usageText(tokenValue(group.tokens.cacheWriteInput, group.attempts), locale.value) }] : []),
    { key: 'cost', label: t('modelSettings.usage.cost'), text: usageText(cost, locale.value, cost.kind === 'unknown' ? undefined : cost.currency),
      source: cost.kind === 'unknown' ? '' : t('modelSettings.usage.sources.estimate') },
  ]
}

watch(range, load, { immediate: true })
onBeforeUnmount(() => reading?.abort())
</script>

<template>
  <section class="model-usage" aria-labelledby="model-usage-title" data-model-usage>
    <div class="model-usage-bar">
      <h2 id="model-usage-title">{{ t('modelSettings.usage.title') }}</h2>
      <UiSegmented v-model="range" :options="windowOptions" :label="t('modelSettings.usage.window')" />
      <GrowthLoading v-if="loading && payload" variant="inline" :label="t('modelSettings.usage.loading')" />
    </div>
    <GrowthLoading v-if="loading && !payload" variant="compact" :label="t('modelSettings.usage.loading')" />
    <div v-else-if="error && !payload" class="model-usage-empty" role="alert">
      <p>{{ t('modelSettings.usage.loadFailed') }} {{ error }}</p>
      <Button variant="outline" size="sm" @click="load">{{ t('modelSettings.retry') }}</Button>
    </div>
    <template v-else-if="payload">
      <p v-if="error" class="model-usage-error" role="alert">{{ error }}</p>
      <p v-if="!rows.model.length && !rows.session.length" class="model-usage-empty" data-usage-empty>{{ t('modelSettings.usage.empty') }}</p>
      <template v-for="list in (['model', 'session'] as const)" :key="list">
        <section v-if="rows[list].length" class="model-usage-list" :aria-labelledby="list === 'session' ? 'model-usage-session' : undefined"
          :aria-label="list === 'model' ? t('modelSettings.usage.title') : undefined" :data-usage-list="list">
          <h3 v-if="list === 'session'" id="model-usage-session">{{ t('modelSettings.usage.session') }}</h3>
          <ul class="model-usage-grid">
            <li v-for="row in rows[list]" :key="row.key">
              <article class="model-usage-card" :data-usage-row="row.key">
                <header>
                  <strong>{{ roleName(row.group.role) }}</strong>
                  <span v-if="row.group.model" class="model-usage-model" :title="row.group.provider ?? undefined">{{ row.group.model }}</span>
                  <Badge variant="outline">{{ t(`modelSettings.usage.sources.${row.group.channel}`) }}</Badge>
                </header>
                <div class="model-usage-meter" aria-hidden="true">
                  <span v-if="row.share !== null" :style="{ inlineSize: `${Math.max(2, row.share * 100)}%` }" />
                </div>
                <dl>
                  <div>
                    <dt>{{ t('modelSettings.usage.calls') }}</dt>
                    <dd>{{ t('modelSettings.usage.callsValue', { calls: row.group.requests, attempts: row.group.attempts }) }}
                      <span v-if="row.group.failedAttempts" class="model-usage-failed">{{ t('modelSettings.usage.failed', { count: row.group.failedAttempts }) }}</span>
                    </dd>
                  </div>
                  <div v-for="cell in cells(row)" :key="cell.key" :data-usage-cell="cell.key">
                    <dt>{{ cell.label }}<small v-if="cell.source"> · {{ cell.source }}</small></dt>
                    <dd>{{ cell.text }}</dd>
                  </div>
                </dl>
              </article>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.model-usage { container-type: inline-size; display: grid; gap: 12px; min-width: 0; }
.model-usage-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.model-usage-bar h2, .model-usage-list h3 { margin: 0; font-size: 16px; font-weight: 600; }
.model-usage-list { display: grid; gap: 8px; min-width: 0; }
.model-usage-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 0; padding: 0; list-style: none; }
@container (min-width: 620px) { .model-usage-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@container (min-width: 960px) { .model-usage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (min-width: 1400px) { .model-usage-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.model-usage-card { display: grid; gap: 10px; height: 100%; min-width: 0; padding: 16px; border: 1px solid var(--color-border);
  border-radius: var(--radius-card); background: var(--color-surface); }
.model-usage-card header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; }
.model-usage-model { min-width: 0; color: var(--color-muted); font-family: var(--font-mono); font-size: 12.5px; overflow-wrap: anywhere; }
.model-usage-meter { block-size: 6px; border-radius: 999px; background: var(--color-surface-subtle); overflow: hidden; }
.model-usage-meter span { display: block; block-size: 100%; border-radius: inherit; background: var(--color-accent); }
.model-usage-card dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; margin: 0; }
.model-usage-card dl > div:first-child { grid-column: 1 / -1; }
.model-usage-card dt { color: var(--color-muted); font-size: 12px; }
.model-usage-card dd { margin: 2px 0 0; font-size: 14px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.model-usage-failed { margin-inline-start: 6px; color: var(--color-danger); font-size: 12px; }
.model-usage-empty { display: grid; justify-items: start; gap: 8px; margin: 0; padding: 16px; border: 1px dashed var(--color-border);
  border-radius: var(--radius-card); color: var(--color-muted); font-size: 14px; }
.model-usage-empty p { margin: 0; }
.model-usage-error { margin: 0; color: var(--color-danger); font-size: 14px; }
</style>
