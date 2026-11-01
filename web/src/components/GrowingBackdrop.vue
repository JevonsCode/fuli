<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { startGrowingBackdrop } from '@/lib/growing-backdrop'
import { motionPreference, motionReduced } from '@/lib/motion-preference'

// The page's slowly growing backdrop: two soft glows, gold low on the left
// and green high on the right, painted once and stepped by transform (see
// lib/growing-backdrop). It sits behind the page and takes no input.
const layer = ref<HTMLElement | null>(null)
let backdrop: ReturnType<typeof startGrowingBackdrop> | null = null
const systemReduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const resume = () => backdrop?.resume()

onMounted(() => {
  if (layer.value) backdrop = startGrowingBackdrop(layer.value, motionReduced)
  systemReduced?.addEventListener('change', resume)
})
watch(motionPreference, resume)
onBeforeUnmount(() => {
  backdrop?.stop()
  systemReduced?.removeEventListener('change', resume)
})
</script>

<template>
  <div ref="layer" class="growing-backdrop" aria-hidden="true" />
</template>

<style scoped>
.growing-backdrop {
  position: absolute; inset: -8%; z-index: -1; pointer-events: none; will-change: transform;
  background:
    radial-gradient(42% 46% at 18% 88%, color-mix(in srgb, var(--color-gold) 13%, transparent), transparent 70%),
    radial-gradient(38% 42% at 84% 14%, color-mix(in srgb, var(--color-success) 8%, transparent), transparent 70%);
}
</style>
