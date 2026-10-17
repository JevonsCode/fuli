<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

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
  <button
    v-if="visible"
    type="button"
    class="back-to-top quiet-button"
    data-back-to-top
    @click="backToTop"
  >
    ↑ {{ t('ui.backToTop') }}
  </button>
</template>

<style scoped>
.back-to-top {
  position: sticky;
  bottom: 16px;
  z-index: 2;
  display: flex;
  margin: 16px 0 0 auto;
  background: var(--color-surface);
  box-shadow: 0 4px 14px rgb(27 31 29 / 12%);
}
</style>
