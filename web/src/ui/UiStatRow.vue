<script setup lang="ts">
// The counts at the top of a page, one look everywhere. An item with
// `pressed` defined is a filter (a toggle button); without it, plain text.
// A tone colours only the small dot, never the whole pill.
export interface UiStat {
  key: string
  label: string
  value: string | number
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
  pressed?: boolean
  ariaLabel?: string
  /** A glossary term id, so 「?」 mode can explain the count. */
  term?: string
}
defineProps<{ items: readonly UiStat[]; label: string }>()
defineEmits<{ select: [key: string] }>()
</script>

<template>
  <div class="ui-stat-row" role="group" :aria-label="label">
    <template v-for="item in items" :key="item.key">
      <button v-if="item.pressed !== undefined" type="button" class="ui-stat" :class="`is-${item.tone ?? 'neutral'}`"
        :aria-pressed="item.pressed" :aria-label="item.ariaLabel" :data-stat="item.key" :data-term="item.term" @click="$emit('select', item.key)">
        <i aria-hidden="true" />{{ item.label }}<strong>{{ item.value }}</strong>
      </button>
      <span v-else class="ui-stat" :class="`is-${item.tone ?? 'neutral'}`" :aria-label="item.ariaLabel" :data-stat="item.key" :data-term="item.term">
        <i aria-hidden="true" />{{ item.label }}<strong>{{ item.value }}</strong>
      </span>
    </template>
  </div>
</template>

<style scoped>
.ui-stat-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ui-stat {
  --stat: var(--color-faint);
  display: inline-flex; align-items: center; gap: 7px; height: 30px; padding: 0 12px 0 10px;
  border: 1px solid var(--color-border); border-radius: var(--radius-pill);
  color: var(--color-ink-soft); background: var(--color-surface); font: inherit; font-size: 13px; line-height: 1;
}
.ui-stat i { width: 6px; height: 6px; border-radius: 50%; background: var(--stat); }
.ui-stat strong { color: var(--color-ink); font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.ui-stat.is-accent { --stat: var(--color-accent); }
.ui-stat.is-success { --stat: var(--color-success); }
.ui-stat.is-warning { --stat: var(--color-warning); }
.ui-stat.is-danger { --stat: var(--color-danger); }
button.ui-stat { cursor: pointer; transition: border-color var(--motion-fast), background var(--motion-fast); }
button.ui-stat:hover { border-color: var(--color-border-strong); }
button.ui-stat[aria-pressed='true'] { border-color: var(--color-ink-soft); background: var(--color-surface-subtle); }
button.ui-stat:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
</style>
