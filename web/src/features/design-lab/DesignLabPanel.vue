<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { t } from '@/i18n'
import { motionPreference, setMotionPreference } from '@/lib/motion-preference'
import { PALETTES, palettePreference, setPalettePreference } from '@/lib/palette-preference'
import { UiButton, UiIconButton, UiSegmented, UiToggle } from '@/ui'
import { PAGE_TRANSITIONS, designLab, resetDesignLab } from './design-lab'
import { WORKBENCH_VARIANTS } from './workbench-variants'
import './design-lab.css'

// A floating, draggable panel for trying designs on the real console.
const panel = ref<HTMLElement | null>(null)
const paletteOptions = computed(() => PALETTES.map(value => ({
  value, label: t(`designLab.palettes.${value}`), swatch: `var(--palette-swatch-${value})`,
})))
const transitionOptions = computed(() => PAGE_TRANSITIONS.map(value => ({ value, label: t(`designLab.transitions.${value}`) })))
const workbenchOptions = computed(() => WORKBENCH_VARIANTS.map(({ id, labelKey }) => ({ value: id, label: t(labelKey) })))
const position = computed(() => designLab.value.x === null || designLab.value.y === null
  ? undefined
  : { left: `${designLab.value.x}px`, top: `${designLab.value.y}px`, right: 'auto', bottom: 'auto' })

let drag: { dx: number; dy: number } | null = null
function startDrag(event: PointerEvent) {
  if (!panel.value || (event.target as HTMLElement).closest('button')) return
  const rect = panel.value.getBoundingClientRect()
  drag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  window.addEventListener('pointermove', moveDrag)
  window.addEventListener('pointerup', endDrag, { once: true })
}
function moveDrag(event: PointerEvent) {
  if (!drag || !panel.value) return
  // Keep the whole panel on screen.
  const { width, height } = panel.value.getBoundingClientRect()
  designLab.value.x = Math.round(Math.min(Math.max(0, event.clientX - drag.dx), window.innerWidth - width))
  designLab.value.y = Math.round(Math.min(Math.max(0, event.clientY - drag.dy), window.innerHeight - height))
}
function endDrag() {
  drag = null
  window.removeEventListener('pointermove', moveDrag)
}
onBeforeUnmount(endDrag)
function reset() {
  resetDesignLab()
  setPalettePreference('jade')
  setMotionPreference('system')
}
</script>

<template>
  <UiIconButton v-if="!designLab.open" class="design-lab-launcher" icon="grid" :label="t('designLab.open')" data-design-lab-open
    @click="designLab.open = true" />
  <section v-else ref="panel" class="design-lab" :style="position" :aria-label="t('designLab.title')" data-design-lab>
    <header class="design-lab-head" :title="t('designLab.drag')" @pointerdown="startDrag">
      <strong>{{ t('designLab.title') }}</strong>
      <UiIconButton icon="close" size="sm" :label="t('designLab.close')" data-design-lab-close @click="designLab.open = false" />
    </header>
    <p class="design-lab-hint">{{ t('designLab.hint') }}</p>

    <div class="design-lab-group">
      <span class="design-lab-label">{{ t('designLab.palette') }}</span>
      <UiSegmented class="design-lab-choices" data-lab-palette :model-value="palettePreference" :options="paletteOptions"
        :label="t('designLab.palette')" @update:model-value="setPalettePreference" />
    </div>

    <div class="design-lab-group">
      <span class="design-lab-label">{{ t('designLab.motion') }}</span>
      <label class="design-lab-row">
        <span>{{ t('designLab.reduceMotion') }}</span>
        <UiToggle :model-value="motionPreference === 'reduced'" :label="t('designLab.reduceMotion')"
          @update:model-value="value => setMotionPreference(value ? 'reduced' : 'system')" />
      </label>
      <div class="design-lab-row">
        <span>{{ t('designLab.transition') }}</span>
        <UiSegmented v-model="designLab.transition" data-lab-transition :options="transitionOptions" :label="t('designLab.transition')" />
      </div>
      <label class="design-lab-row">
        <span>{{ t('designLab.cardLift') }}</span>
        <UiToggle v-model="designLab.cardLift" data-lab-lift :label="t('designLab.cardLift')" />
      </label>
    </div>

    <div v-if="workbenchOptions.length > 1" class="design-lab-group">
      <span class="design-lab-label">{{ t('designLab.workbench.title') }}</span>
      <UiSegmented v-model="designLab.workbench" class="design-lab-choices" data-lab-workbench :options="workbenchOptions"
        :label="t('designLab.workbench.title')" />
    </div>

    <footer class="design-lab-foot">
      <UiButton variant="ghost" size="sm" data-design-lab-reset @click="reset">{{ t('designLab.reset') }}</UiButton>
    </footer>
  </section>
</template>

<style scoped>
.design-lab-launcher {
  position: fixed; right: 20px; bottom: 20px; z-index: var(--z-popover);
  border: 1px solid var(--color-border); background: var(--color-surface); box-shadow: var(--shadow-md);
}
.design-lab {
  position: fixed; right: 20px; bottom: 20px; z-index: var(--z-popover); display: grid; gap: 14px; width: 340px; max-width: calc(100vw - 32px);
  padding: 12px 14px 12px; border: 1px solid var(--color-border); border-radius: var(--radius-card);
  color: var(--color-ink); background: var(--color-surface); box-shadow: var(--shadow-popover);
}
.design-lab-head { display: flex; align-items: center; justify-content: space-between; margin: -4px -6px 0 0; cursor: grab; user-select: none; touch-action: none; }
.design-lab-head:active { cursor: grabbing; }
.design-lab-head strong { font-size: 14px; font-weight: 650; }
.design-lab-hint { margin: -10px 0 0; color: var(--color-muted); font-size: 12px; line-height: 1.5; }
.design-lab-group { display: grid; gap: 8px; }
.design-lab-label { color: var(--color-faint); font-size: 12px; font-weight: 600; }
.design-lab-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--color-ink-soft); font-size: 13px; }
.design-lab-choices { flex-wrap: wrap; }
.design-lab-foot { display: flex; justify-content: flex-end; }
/* Narrow screens have the bottom tab bar: sit above it, never over a tab. */
@media (max-width: 720px) {
  .design-lab-launcher, .design-lab { bottom: calc(60px + env(safe-area-inset-bottom) + 12px); }
  .design-lab { right: 16px; max-height: calc(100dvh - 60px - env(safe-area-inset-bottom) - 28px); overflow: auto; }
  .design-lab-launcher { right: 16px; }
}
</style>
