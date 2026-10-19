<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { t } from '@/i18n'

const props = withDefaults(defineProps<{
  scroller: HTMLElement | null
  threshold?: number
}>(), { threshold: 600 })

const visible = ref(false)

function update() {
  visible.value = (props.scroller?.scrollTop ?? 0) > props.threshold
}

watch(() => props.scroller, (element, previous) => {
  previous?.removeEventListener('scroll', update)
  element?.addEventListener('scroll', update, { passive: true })
  update()
}, { immediate: true })

onBeforeUnmount(() => props.scroller?.removeEventListener('scroll', update))

function backToTop() {
  // Jump without smooth scrolling so reduced-motion needs no special case.
  if (props.scroller) props.scroller.scrollTop = 0
  update()
}
</script>

<template>
  <!-- Icon only: a circle with an up chevron needs no words; the label stays for assistive tech. -->
  <Button
    v-if="visible"
    variant="outline"
    size="icon"
    class="back-to-top"
    data-back-to-top
    :aria-label="t('ui.backToTop')"
    :title="t('ui.backToTop')"
    @click="backToTop"
  >
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" /></svg>
  </Button>
</template>

<style scoped>
/* A floating circle; the look comes from Button (outline, icon size). */
.back-to-top {
  position: sticky;
  bottom: 16px;
  z-index: 2;
  margin: 16px 0 0 auto;
  border-radius: 50%;
  box-shadow: var(--shadow-md);
  transition: transform var(--motion-fast) var(--motion-ease), color var(--motion-fast);
}
.back-to-top:hover { color: var(--color-accent); transform: translateY(-2px); }
</style>
