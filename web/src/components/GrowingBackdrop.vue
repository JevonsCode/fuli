<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { startBackdropParallax } from '@/lib/backdrop-parallax'
import { motionReduced } from '@/lib/motion-preference'
import { pageBackdrop } from '@/lib/page-backdrops'

// The page's growing backdrop: the current destination's motif (see
// lib/page-backdrops), painted once per layer. Each layer drifts and breathes
// on its own long clock, by transform and opacity only, so the compositor
// moves it and nothing is laid out or painted again; reduced motion zeroes
// those animations in primitives.css and the layers rest. A mouse leans the
// layers a few pixels by depth (lib/backdrop-parallax). A change of
// destination crossfades the motifs. It sits behind the page and takes no input.
const props = defineProps<{ destination?: string }>()
const backdrop = computed(() => pageBackdrop(props.destination))

const stage = ref<HTMLElement>()
let stopParallax: (() => void) | undefined
onMounted(() => { stopParallax = startBackdropParallax(stage.value!, motionReduced) })
onBeforeUnmount(() => stopParallax?.())
</script>

<template>
  <div ref="stage" class="backdrop-stage" aria-hidden="true">
    <Transition name="backdrop-fade">
      <div :key="backdrop.key" class="growing-backdrop" :data-backdrop="backdrop.key">
        <div v-for="(layer, index) in backdrop.layers" :key="index" class="backdrop-layer" :style="{ background: layer }" />
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.backdrop-stage { position: absolute; inset: 0; z-index: -1; pointer-events: none; }
/* The overhang keeps the edges covered at the widest drift and lean. */
.growing-backdrop { position: absolute; inset: -8%; }
.backdrop-layer {
  --depth: 1;
  position: absolute; inset: 0; will-change: transform, opacity;
  translate: calc(var(--parallax-x, 0) * var(--depth) * 1px) calc(var(--parallax-y, 0) * var(--depth) * 1px);
  animation:
    backdrop-drift-1 var(--motion-backdrop-cycle) ease-in-out infinite alternate,
    backdrop-breathe calc(var(--motion-backdrop-cycle) * .57) ease-in-out infinite alternate;
}
.backdrop-layer:nth-child(2) {
  --depth: 2;
  animation-name: backdrop-drift-2, backdrop-breathe;
  animation-duration: calc(var(--motion-backdrop-cycle) * 1.27), calc(var(--motion-backdrop-cycle) * .43);
  animation-delay: calc(var(--motion-backdrop-cycle) * -.4), calc(var(--motion-backdrop-cycle) * -.2);
}
.backdrop-layer:nth-child(3) {
  --depth: 3;
  animation-name: backdrop-drift-3, backdrop-breathe;
  animation-duration: calc(var(--motion-backdrop-cycle) * .77), calc(var(--motion-backdrop-cycle) * .63);
  animation-delay: calc(var(--motion-backdrop-cycle) * -.25), calc(var(--motion-backdrop-cycle) * -.3);
}
@keyframes backdrop-drift-1 {
  from { transform: translate3d(-2%, 1.5%, 0) scale(1); }
  to { transform: translate3d(2%, -2%, 0) scale(1.08); }
}
@keyframes backdrop-drift-2 {
  from { transform: translate3d(2%, 0, 0) scale(1.05); }
  to { transform: translate3d(-2%, -1.5%, 0) scale(1); }
}
@keyframes backdrop-drift-3 {
  from { transform: translate3d(0, 1.5%, 0) scale(1); }
  to { transform: translate3d(1.5%, -1.5%, 0) scale(1.1); }
}
@keyframes backdrop-breathe {
  from { opacity: 1; }
  to { opacity: .4; }
}
.backdrop-fade-enter-active, .backdrop-fade-leave-active { transition: opacity var(--motion-crossfade) var(--motion-ease-out); }
.backdrop-fade-enter-from, .backdrop-fade-leave-to { opacity: 0; }
</style>
