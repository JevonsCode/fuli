<script setup lang="ts">
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'

// A top-bar button's own hover panel (Jevons 11-06: not the browser's grey title tooltip).
// It opens on hover intent or keyboard focus under the button, in the frosted glass every
// floating piece uses, and the button underneath keeps its place and its click.
// align: which edge of the trigger the panel lines up with. v-model:open lets a
// trigger whose click only opens the panel (no action of its own) toggle it too.
withDefaults(defineProps<{ align?: 'start' | 'end' }>(), { align: 'end' })
const open = defineModel<boolean>('open')
</script>

<template>
  <HoverCard v-model:open="open" :open-delay="260" :close-delay="140">
    <HoverCardTrigger as-child>
      <slot name="trigger" />
    </HoverCardTrigger>
    <HoverCardContent :align="align" :side-offset="8" class="header-peek" data-header-peek>
      <slot />
    </HoverCardContent>
  </HoverCard>
</template>

<style>
/* Unscoped: the panel is portalled out of this component. */
.header-peek {
  display: grid; gap: 10px; width: 312px; padding: 12px 14px;
  border: 1px solid var(--edge-glass); border-radius: var(--radius-card);
  color: var(--color-ink); background: var(--glass-sheen), var(--surface-dock-panel);
  -webkit-backdrop-filter: var(--filter-dock); backdrop-filter: var(--filter-dock);
  box-shadow: var(--shadow-popover);
}
.header-peek-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.header-peek-title { font-size: var(--text-body); font-weight: var(--weight-medium); }
.header-peek-meta { color: var(--color-muted); font-size: var(--text-meta); white-space: nowrap; }
.header-peek-list { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.header-peek-row { display: flex; align-items: center; gap: 8px; min-width: 0; font-size: var(--text-meta); }
.header-peek-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.header-peek-tag { flex: 0 0 auto; color: var(--color-muted); }
.header-peek-empty { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.header-peek .is-problem { color: var(--color-danger); }
.header-peek-go {
  justify-self: end; color: var(--color-link, var(--color-ink)); font-size: var(--text-meta);
  font-weight: var(--weight-medium); text-decoration: none; user-select: none;
}
.header-peek-go:hover { text-decoration: underline; text-underline-offset: 3px; }
</style>
