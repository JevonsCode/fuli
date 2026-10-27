<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import { UiPopover } from '@/ui'
import { findTerm, type GlossaryTerm } from './terms'
import { useGlossaryMode } from './glossary-mode'

// While glossary mode is on, the cursor changes, the term under it is
// outlined, and a click explains that term instead of activating the control.
const { held, pinned, active } = useGlossaryMode()
const selected = ref<{ term: GlossaryTerm; anchor: DOMRect } | null>(null)
let highlighted: HTMLElement | null = null

function highlight(element: HTMLElement | null) {
  if (highlighted === element) return
  highlighted?.removeAttribute('data-glossary-hit')
  highlighted = element
  highlighted?.setAttribute('data-glossary-hit', '')
}

// Leaving the mode also closes an open explanation.
function leave() {
  held.value = false
  pinned.value = false
  selected.value = null
}

// Alt shows the mode while held; pressed while it is pinned, it also unpins,
// so the mode ends when Alt comes back up. Esc leaves at once.
function onKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && (active.value || selected.value)) return leave()
  if (event.key !== 'Alt' || event.repeat) return
  // Alt alone would otherwise move focus to the browser menu on Windows.
  event.preventDefault()
  pinned.value = false
  held.value = true
}
function onKeyUp(event: KeyboardEvent) { if (event.key === 'Alt') held.value = false }
// A right-click leaves the mode instead of opening the context menu.
function onContextMenu(event: MouseEvent) {
  if (!active.value) return
  event.preventDefault()
  leave()
}
function onBlur() { held.value = false }
function onPointerMove(event: PointerEvent) { if (active.value) highlight(findTerm(event.target)?.element ?? null) }
function onClick(event: MouseEvent) {
  if (!active.value || (event.target instanceof Element && event.target.closest('[data-glossary-toggle]'))) return
  // Alt+click would download links; in this mode a click only ever explains.
  event.preventDefault()
  event.stopPropagation()
  const hit = findTerm(event.target)
  if (hit) selected.value = { term: hit.term, anchor: hit.element.getBoundingClientRect() }
}

watch(active, on => {
  document.documentElement.toggleAttribute('data-glossary', on)
  if (!on) highlight(null)
}, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  window.addEventListener('pointermove', onPointerMove, { passive: true })
  window.addEventListener('click', onClick, true)
  window.addEventListener('contextmenu', onContextMenu, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('blur', onBlur)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('click', onClick, true)
  window.removeEventListener('contextmenu', onContextMenu, true)
  leave()
  highlight(null)
  document.documentElement.removeAttribute('data-glossary')
})
</script>

<template>
  <span v-if="active" class="glossary-live" role="status">{{ t('glossary.modeOn') }}</span>
  <UiPopover :open="Boolean(selected)" :anchor="selected?.anchor ?? null" :label="selected ? t(selected.term.labelKey) : ''"
    @close="selected = null">
    <div v-if="selected" class="glossary-card" :data-glossary-term="selected.term.id">
      <small>{{ t(`glossary.groups.${selected.term.group}`) }}</small>
      <strong>{{ t(selected.term.labelKey) }}</strong>
      <p>{{ t(selected.term.bodyKey) }}</p>
    </div>
  </UiPopover>
</template>

<style scoped>
.glossary-live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.glossary-card { display: grid; gap: 4px; max-width: 280px; }
.glossary-card small { color: var(--color-muted); font-size: 11px; font-weight: 650; letter-spacing: .04em; }
.glossary-card strong { font-size: 14px; }
.glossary-card p { margin: 0; color: var(--color-ink-soft); font-size: 13px; line-height: 1.55; }
</style>

<style>
/* A drawn cursor (ring with a question mark), not the native help cursor. */
:root[data-glossary], :root[data-glossary] * {
  cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 28 28'%3E%3Ccircle cx='14' cy='14' r='11' fill='%23ffffff' fill-opacity='.92' stroke='%230f6b55' stroke-width='2.4'/%3E%3Cpath d='M11 11.2a3 3 0 1 1 4.3 2.7c-.9.5-1.3 1-1.3 2v.6' fill='none' stroke='%230f6b55' stroke-width='2.2' stroke-linecap='round'/%3E%3Ccircle cx='14' cy='19.6' r='1.3' fill='%230f6b55'/%3E%3C/svg%3E") 14 14, help !important;
}
/* Drawn inside the term's own box, so a scrolling or clipping parent (the
   section tabs scroll sideways) never cuts it off. */
[data-glossary-hit] { outline: 2px dashed var(--color-accent); outline-offset: -2px; }
</style>
