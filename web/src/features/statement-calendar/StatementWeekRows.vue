<script setup lang="ts">
import { computed } from 'vue'
import { statementDetails, type Statement } from '@/features/today/statement'

// One week's statement as the rows of 「查看详情」: every number with what it
// counts and who saw it. The same list as features/today/StatementDetails.vue
// draws; to be folded into one component once that dialog is free to change.
const props = defineProps<{ statement: Statement }>()
const rows = computed(() => statementDetails(props.statement))
</script>

<template>
  <dl class="statement-week-rows">
    <div v-for="row in rows" :key="row.key" class="statement-week-row" :data-statement-detail="row.key">
      <dt>{{ row.label }}</dt>
      <dd class="statement-week-value">{{ row.value }}</dd>
      <dd class="statement-week-what">{{ row.what }} · {{ row.source }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.statement-week-rows { margin: 0; }
.statement-week-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 12px; padding: 8px 0; }
.statement-week-row + .statement-week-row { border-top: 1px solid var(--color-border); }
.statement-week-row dt { font-size: var(--text-body); font-weight: var(--weight-medium); }
.statement-week-row dd { margin: 0; }
.statement-week-value { font-size: var(--text-body); font-weight: var(--weight-medium); font-variant-numeric: tabular-nums; }
.statement-week-what { grid-column: 1 / -1; color: var(--color-muted); font-size: var(--text-meta); }
</style>
