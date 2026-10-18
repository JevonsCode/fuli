<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

// A small panel anchored to a point (e.g. the clicked element). It flips to
// stay on screen, closes on Escape or an outside click, and returns focus.
const props = defineProps<{ open: boolean; anchor: DOMRect | null; label: string }>()
const emit = defineEmits<{ close: [] }>()
const panel = ref<HTMLElement | null>(null)
const placement = ref({ top: 0, left: 0 })
const style = computed(() => ({ top: `${placement.value.top}px`, left: `${placement.value.left}px` }))

async function place() {
  await nextTick()
  if (!props.anchor || !panel.value) return
  const { width, height } = panel.value.getBoundingClientRect()
  const gap = 8
  const below = props.anchor.bottom + gap
  const top = below + height > window.innerHeight ? Math.max(gap, props.anchor.top - height - gap) : below
  const left = Math.min(Math.max(gap, props.anchor.left), window.innerWidth - width - gap)
  placement.value = { top, left }
  panel.value.focus()
}

function onKey(event: KeyboardEvent) { if (event.key === 'Escape') emit('close') }
function onPointer(event: PointerEvent) {
  if (panel.value && !panel.value.contains(event.target as Node)) emit('close')
}

watch(() => [props.open, props.anchor] as const, ([open]) => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onPointer, true)
  if (!open) return
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerdown', onPointer, true)
  void place()
}, { immediate: true })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerdown', onPointer, true)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="panel" class="ui-popover" role="dialog" :aria-label="label" tabindex="-1" :style="style">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.ui-popover {
  position: fixed; z-index: var(--z-popover); max-width: min(360px, calc(100vw - 16px)); padding: 12px 14px;
  border: 1px solid var(--color-border); border-radius: var(--radius-card); color: var(--color-ink);
  background: var(--color-surface); box-shadow: var(--shadow-popover); font-size: 13px; line-height: 1.6;
  animation: ui-popover-in var(--motion-fast) var(--motion-ease);
}
.ui-popover:focus { outline: none; }
@keyframes ui-popover-in { from { opacity: 0; transform: translateY(-3px); } }
@media (prefers-reduced-motion: reduce) { .ui-popover { animation: none; } }
</style>
