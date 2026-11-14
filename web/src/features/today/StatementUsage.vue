<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import ClientInitial from './ClientInitial.vue'
import { usageRows, type StatementUsage } from './statement-usage'

// 用了哪些客户端和模型, under the statement's numbers: one row per client and
// model with the client's mark, its counts and who saw them. A model no
// client reported reads 模型未知. Nothing to show says nothing. The per-client
// record started later than the statement's own counts, so one line says the
// rows can add up to less than the totals above.
const props = withDefaults(defineProps<{ usage: StatementUsage | null; busy?: boolean }>(), { busy: false })
const rows = computed(() => usageRows(props.usage))
</script>

<template>
  <section v-if="rows.length" class="statement-usage" :aria-busy="busy" data-statement-usage>
    <h3 class="statement-usage-title">{{ t('today.usage.title') }}</h3>
    <ul class="statement-usage-rows">
      <li v-for="row in rows" :key="row.key" class="statement-usage-row" :data-statement-usage-row="row.client">
        <ClientInitial :client="row.client" :label="row.clientName" />
        <span class="statement-usage-name">{{ row.clientName }} · {{ row.model }}</span>
        <span class="statement-usage-counts">{{ row.counts }}</span>
        <span class="statement-usage-source">{{ row.source }}</span>
      </li>
    </ul>
    <p class="statement-usage-more" data-statement-usage-partial>{{ t('today.usage.partial') }}</p>
    <p v-if="usage?.more" class="statement-usage-more">{{ t('today.usage.more') }}</p>
  </section>
</template>

<style scoped>
.statement-usage { display: grid; gap: 4px; padding-top: 12px; border-top: 1px solid var(--color-border); }
.statement-usage-title { margin: 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular); user-select: none; }
.statement-usage-rows { margin: 0; padding: 0; list-style: none; }
.statement-usage-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 8px; padding: 8px 0; }
.statement-usage-row + .statement-usage-row { border-top: 1px solid var(--color-border); }
.statement-usage-name { overflow: hidden; font-size: var(--text-body); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.statement-usage-counts { font-size: var(--text-body); font-variant-numeric: tabular-nums; transition: opacity var(--motion-fast); }
.statement-usage[aria-busy='true'] .statement-usage-counts { opacity: 0.45; }
.statement-usage-source { grid-column: 2 / -1; color: var(--color-muted); font-size: var(--text-meta); }
.statement-usage-more { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
</style>
