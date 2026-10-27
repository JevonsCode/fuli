<script setup lang="ts">
import { computed } from 'vue'
import UiIcon from './UiIcon.vue'
import type { IconName } from './icons'

// An inline status line: live updates stopped, part of a read failed, what an
// action did. One icon, the sentence, then its actions right after it, on a
// soft tint of its tone. It hugs its content, so a short line never becomes a
// wide empty band. An error is announced at once, the others politely.
type NoticeTone = 'info' | 'success' | 'warning' | 'error'
const props = withDefaults(defineProps<{ tone?: NoticeTone; role?: 'status' | 'alert' | 'note' }>(), { tone: 'info', role: undefined })
const ICON: Record<NoticeTone, IconName> = { info: 'info', success: 'check', warning: 'warning', error: 'error' }
const liveRole = computed(() => props.role ?? (props.tone === 'error' ? 'alert' : 'status'))
</script>

<template>
  <div class="ui-notice" :class="`is-${tone}`" :role="liveRole" :data-tone="tone">
    <UiIcon class="ui-notice__icon" :name="ICON[tone]" :size="16" />
    <div class="ui-notice__text"><slot /></div>
    <div v-if="$slots.actions" class="ui-notice__actions"><slot name="actions" /></div>
  </div>
</template>

<style scoped>
.ui-notice {
  display: flex; flex-wrap: wrap; align-items: flex-start; gap: 4px 8px; width: fit-content; max-width: 100%;
  padding: 8px 12px; border-radius: var(--radius-control); color: var(--color-ink-soft); background: var(--color-surface-subtle);
  font-size: var(--text-control); line-height: 1.5;
}
.ui-notice__icon { margin-top: 2px; color: var(--color-muted); }
.ui-notice__text { flex: 0 1 auto; min-width: 0; max-width: var(--measure); overflow-wrap: anywhere; }
.ui-notice__text :deep(p) { margin: 0; }
/* Actions sit beside the sentence and never stretch the line. */
.ui-notice__actions { display: flex; flex-wrap: wrap; align-items: center; align-self: center; gap: 4px; margin-block: -4px; }
.ui-notice.is-success { background: var(--color-success-soft); }
.ui-notice.is-success .ui-notice__icon { color: var(--color-success); }
.ui-notice.is-warning { background: var(--color-warning-soft); }
.ui-notice.is-warning .ui-notice__icon { color: var(--color-warning); }
.ui-notice.is-error { background: var(--color-danger-soft); }
.ui-notice.is-error .ui-notice__icon { color: var(--color-danger); }
</style>
