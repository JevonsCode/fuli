<script setup lang="ts">
import { t } from '@/i18n'
import { UiButton, UiIcon, UiIconButton } from '@/ui'
import { useGlossaryMode } from './glossary-mode'

// Off: a small ⓘ. Pinned on: a wide "put it back" strip with a tray that
// wiggles now and then, so returning the question-mark cursor is one easy click.
const glossary = useGlossaryMode()
</script>

<template>
  <UiButton v-if="glossary.pinned.value" class="glossary-return" size="sm" data-glossary-toggle data-glossary-return
    :aria-label="t('glossary.toggleOn')" :title="t('glossary.toggleOn')" @click="glossary.toggle">
    <UiIcon class="glossary-return-icon" name="tray" :size="16" />{{ t('glossary.return') }}
  </UiButton>
  <UiIconButton v-else icon="info" data-glossary-toggle :active="glossary.active.value"
    :label="t('glossary.toggle')" @click="glossary.toggle" />
</template>

<style scoped>
.glossary-return { gap: 6px; min-width: 128px; border-color: var(--color-accent-line); color: var(--color-accent); background: var(--color-accent-soft); }
.glossary-return-icon { transform-origin: 50% 80%; animation: glossary-tray-wiggle 3.6s ease-in-out infinite; }
/* Still most of the time, then a short shake: a nudge, not a distraction. */
@keyframes glossary-tray-wiggle {
  0%, 82%, 100% { transform: rotate(0); }
  86% { transform: rotate(-12deg); }
  90% { transform: rotate(10deg); }
  94% { transform: rotate(-6deg); }
  97% { transform: rotate(3deg); }
}
@media (prefers-reduced-motion: reduce) { .glossary-return-icon { animation: none; } }
:root[data-motion="reduced"] .glossary-return-icon { animation: none; }
</style>
