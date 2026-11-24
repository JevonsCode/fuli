<script setup lang="ts">
import { computed } from 'vue'
import { statementDetails, type Statement } from './statement'

// Every number of one week's statement, each with what it counts and who saw
// it: the rows of 「查看详情」 and of the week under the calendar. While another
// week is read the last one's numbers stay, dimmed, so nothing jumps.
const props = withDefaults(defineProps<{ statement: Statement; busy?: boolean }>(), { busy: false })
const rows = computed(() => statementDetails(props.statement))
</script>

<template>
  <dl class="statement-rows" :aria-busy="busy" data-statement-rows>
    <div v-for="row in rows" :key="row.key" class="statement-rows-row" :data-statement-detail="row.key">
      <dt>{{ row.label }}</dt>
      <dd class="statement-rows-value">{{ row.value }}</dd>
      <dd class="statement-rows-what">{{ row.what }} · {{ row.source }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.statement-rows { margin: 0; }
.statement-rows-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 12px; padding: 8px 0; }
.statement-rows-row + .statement-rows-row { border-top: 1px solid var(--color-border); }
.statement-rows-row dt { font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-rows-row dd { margin: 0; }
.statement-rows-value { font-size: var(--text-body); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; transition: opacity 160ms ease; }
/* Numbers of the week being left stay readable while the next week is read. */
.statement-rows[aria-busy='true'] .statement-rows-value { opacity: 0.45; }
.statement-rows-what { grid-column: 1 / -1; color: var(--color-muted); font-size: var(--text-meta); }
</style>
