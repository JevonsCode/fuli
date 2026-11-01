<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch, type Directive } from 'vue'
import { startGrowingBackdrop, type BackdropDrift } from '@/lib/growing-backdrop'
import { motionPreference, motionReduced } from '@/lib/motion-preference'
import { pageBackdrop } from '@/lib/page-backdrops'

// The page's slowly growing backdrop: the current destination's motif (see
// lib/page-backdrops), painted once and stepped by transform (see
// lib/growing-backdrop). A change of destination crossfades the layers by
// opacity; reduced motion zeroes the fade in primitives.css. It sits behind
// the page and takes no input.
const props = defineProps<{ destination?: string }>()
const backdrop = computed(() => pageBackdrop(props.destination))

// Each layer drifts on its own clock until it leaves, so a fading layer
// keeps its pose instead of jumping to the new motif's.
type Engine = ReturnType<typeof startGrowingBackdrop>
const engines = new Map<HTMLElement, Engine>()
const vDrift: Directive<HTMLElement, BackdropDrift> = {
  mounted(element, { value }) { engines.set(element, startGrowingBackdrop(element, value, motionReduced)) },
  beforeUnmount(element) { engines.get(element)?.stop(); engines.delete(element) },
}

const systemReduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const resume = () => engines.forEach(engine => engine.resume())
onMounted(() => systemReduced?.addEventListener('change', resume))
watch(motionPreference, resume)
onBeforeUnmount(() => systemReduced?.removeEventListener('change', resume))
</script>

<template>
  <Transition name="backdrop-fade">
    <div :key="backdrop.key" v-drift="backdrop.drift" class="growing-backdrop" :style="{ background: backdrop.background }"
      :data-backdrop="backdrop.key" aria-hidden="true" />
  </Transition>
</template>

<style scoped>
.growing-backdrop { position: absolute; inset: -8%; z-index: -1; pointer-events: none; will-change: transform; }
.backdrop-fade-enter-active, .backdrop-fade-leave-active { transition: opacity var(--motion-crossfade) var(--motion-ease-out); }
.backdrop-fade-enter-from, .backdrop-fade-leave-to { opacity: 0; }
</style>
