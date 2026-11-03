<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { startBackdropParallax } from '@/lib/backdrop-parallax'
import { motionReduced } from '@/lib/motion-preference'
import { pageBackdrop } from '@/lib/page-backdrops'

// The page's growing backdrop: the current destination's motif (see
// lib/page-backdrops), painted once per layer. Each layer drifts and breathes
// on its own long clock, by transform and opacity only, so the compositor
// moves it and nothing is laid out or painted again; reduced motion zeroes
// and leans them out (below), so the layers rest. A mouse leans the
// layers away from it by depth (lib/backdrop-parallax). A change of
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
/* The overhang keeps the edges covered at the widest drift, turn and lean. */
.growing-backdrop { position: absolute; inset: -24%; }
.backdrop-layer {
  --depth: 1;
  position: absolute; inset: 0; will-change: transform, opacity;
  translate: calc(var(--parallax-x, 0) * var(--depth) * 1px) calc(var(--parallax-y, 0) * var(--depth) * 1px);
  animation:
    backdrop-drift-1 var(--motion-backdrop-cycle) ease-in-out infinite alternate,
    backdrop-breathe calc(var(--motion-backdrop-cycle) * .37) ease-in-out infinite alternate;
}
.backdrop-layer:nth-child(2) {
  --depth: 2;
  animation-name: backdrop-drift-2, backdrop-breathe;
  animation-duration: calc(var(--motion-backdrop-cycle) * 1.27), calc(var(--motion-backdrop-cycle) * .31);
  animation-delay: calc(var(--motion-backdrop-cycle) * -.4), calc(var(--motion-backdrop-cycle) * -.2);
}
.backdrop-layer:nth-child(3) {
  --depth: 3;
  animation-name: backdrop-drift-3, backdrop-breathe;
  animation-duration: calc(var(--motion-backdrop-cycle) * .77), calc(var(--motion-backdrop-cycle) * .41);
  animation-delay: calc(var(--motion-backdrop-cycle) * -.25), calc(var(--motion-backdrop-cycle) * -.3);
}
/* Each layer wanders a loop of its own across a good part of the page (11-03:
   幅度要明显加大，一眼能看出在动), swelling and turning as it goes. */
@keyframes backdrop-drift-1 {
  0% { transform: translate3d(-9%, 6%, 0) rotate(-6deg) scale(.92); }
  35% { transform: translate3d(7%, -4%, 0) rotate(4deg) scale(1.18); }
  70% { transform: translate3d(-3%, -9%, 0) rotate(8deg) scale(1.04); }
  100% { transform: translate3d(10%, 7%, 0) rotate(-3deg) scale(1.22); }
}
@keyframes backdrop-drift-2 {
  0% { transform: translate3d(10%, -3%, 0) rotate(5deg) scale(1.15); }
  40% { transform: translate3d(-8%, 8%, 0) rotate(-7deg) scale(.94); }
  75% { transform: translate3d(4%, 10%, 0) rotate(3deg) scale(1.2); }
  100% { transform: translate3d(-10%, -7%, 0) rotate(-4deg) scale(1.02); }
}
@keyframes backdrop-drift-3 {
  0% { transform: translate3d(-4%, 10%, 0) rotate(0deg) scale(.95); }
  30% { transform: translate3d(9%, 2%, 0) rotate(-9deg) scale(1.24); }
  65% { transform: translate3d(-10%, -6%, 0) rotate(6deg) scale(1.06); }
  100% { transform: translate3d(6%, -10%, 0) rotate(10deg) scale(1.16); }
}
@keyframes backdrop-breathe {
  from { opacity: 1; }
  to { opacity: .1; }
}
/* Reduced motion (the system's or the app's switch) rests every layer at its own
   pose, unshifted and fully drawn: a zero-length animation alone would freeze it
   wherever its delay landed, and the parallax lean would stay until the next move.
   !important outranks the per-layer :nth-child animation rules above. */
@media (prefers-reduced-motion: reduce) { .backdrop-layer { animation: none !important; translate: none !important; } }
:root[data-motion="reduced"] .backdrop-layer { animation: none !important; translate: none !important; }
.backdrop-fade-enter-active, .backdrop-fade-leave-active { transition: opacity var(--motion-crossfade) var(--motion-ease-out); }
.backdrop-fade-enter-from, .backdrop-fade-leave-to { opacity: 0; }
</style>
