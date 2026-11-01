<script setup lang="ts">
import { computed } from 'vue'
import { motionReduced } from '@/lib/motion-preference'
import type { HowtoMoveId } from './howto-content'

// A tiny looping scene for one move: who talks to whom when the person says
// it. Decorative (the card's words say everything). The whole scene is drawn
// at rest; only with motion allowed does it loop, so reduced motion shows the
// finished picture.
const props = defineProps<{ move: HowtoMoveId }>()

// motionReduced reads the in-app switch, so turning it on stops the loop at once.
const animated = computed(() => !motionReduced())
// The token the bubble types for moves that start with one.
const TOKENS: Partial<Record<HowtoMoveId, string>> = { continue: '#FLA', discuss: '@FLG', relay: '#FLA', delegate: '#FLA', recruit: '#FLA' }
const token = computed(() => TOKENS[props.move] ?? null)
</script>

<template>
  <svg
    class="howto-scene"
    :class="{ 'is-animated': animated }"
    :data-move="move"
    :data-animated="animated"
    viewBox="0 0 160 72"
    aria-hidden="true"
    focusable="false"
  >
    <g v-if="token" class="howto-bubble">
      <rect x="4" y="24" width="48" height="22" rx="11" />
      <text x="28" y="39" text-anchor="middle">{{ token }}</text>
    </g>

    <template v-if="move === 'anyClient'">
      <rect v-for="y in [8, 30, 52]" :key="y" class="howto-node" x="10" :y="y" width="14" height="12" rx="3" />
      <path v-for="(y, i) in [14, 36, 58]" :key="`l${y}`" class="howto-link" :style="{ '--i': i }" :d="`M26 ${y} C 70 ${y}, 80 36, 112 36`" />
      <circle class="howto-hub" cx="124" cy="36" r="13" />
      <text class="howto-hub-mark" x="124" y="40" text-anchor="middle">F</text>
    </template>

    <template v-else-if="move === 'continue'">
      <path class="howto-link" d="M56 35 H 104" />
      <circle class="howto-actor is-lit" cx="124" cy="35" r="14" />
      <path class="howto-tick" d="M118 35 l4 4 l8 -8" />
    </template>

    <template v-else-if="move === 'discuss'">
      <path v-for="(c, i) in [[110, 14], [140, 36], [110, 58]]" :key="`l${i}`" class="howto-link" :style="{ '--i': i }" :d="`M56 35 L ${c[0] - 10} ${c[1]}`" />
      <g v-for="(c, i) in [[110, 14], [140, 36], [110, 58]]" :key="i" :style="{ '--i': i }">
        <circle class="howto-actor" :cx="c[0]" :cy="c[1]" r="9" />
        <circle class="howto-say" :cx="c[0] + 10" :cy="c[1] - 8" r="3" />
      </g>
    </template>

    <template v-else-if="move === 'relay'">
      <circle class="howto-actor is-lit" cx="76" cy="35" r="11" />
      <circle class="howto-actor" cx="140" cy="35" r="11" />
      <path class="howto-track" d="M88 35 H 128" />
      <circle class="howto-packet" cx="88" cy="35" r="3.5" />
    </template>

    <template v-else-if="move === 'delegate'">
      <circle class="howto-actor is-lit" cx="104" cy="14" r="10" />
      <path v-for="(x, i) in [76, 104, 132]" :key="`l${x}`" class="howto-link" :style="{ '--i': i }" :d="`M104 24 L ${x} 50`" />
      <circle v-for="(x, i) in [76, 104, 132]" :key="x" class="howto-actor is-small" :style="{ '--i': i }" :cx="x" cy="58" r="8" />
    </template>

    <template v-else-if="move === 'recruit'">
      <circle class="howto-actor" cx="80" cy="35" r="10" />
      <circle class="howto-actor" cx="108" cy="35" r="10" />
      <circle class="howto-slot" cx="136" cy="35" r="10" />
      <circle class="howto-actor is-lit howto-arrive" cx="136" cy="35" r="10" />
    </template>

    <template v-else-if="move === 'project'">
      <rect class="howto-node is-parent" x="56" y="6" width="48" height="16" rx="4" />
      <path class="howto-link" d="M80 22 V 36 H 36 V 46 M80 36 H 124 V 46" />
      <rect class="howto-node" x="16" y="48" width="40" height="16" rx="4" />
      <rect class="howto-node is-lit howto-arrive" x="104" y="48" width="40" height="16" rx="4" />
    </template>

    <template v-else-if="move === 'review'">
      <rect class="howto-node" x="30" y="8" width="72" height="56" rx="6" />
      <path v-for="(y, i) in [22, 34, 46]" :key="y" class="howto-line" :style="{ '--i': i }" :d="`M40 ${y} H ${i === 2 ? 76 : 92}`" />
      <circle class="howto-actor is-lit" cx="126" cy="36" r="14" />
      <path class="howto-tick" d="M120 36 l4 4 l8 -8" />
    </template>
  </svg>
</template>

<style scoped>
.howto-scene {
  --howto-loop: calc(var(--motion-pulse) * 2);
  --howto-step: var(--motion-intent);
  display: block; width: 100%; max-width: 200px; height: auto;
  color: var(--color-faint); overflow: visible;
}
.howto-bubble rect { fill: var(--color-surface-subtle); stroke: var(--color-border-strong); stroke-width: 1; }
.howto-bubble text { fill: var(--color-ink); font-family: var(--font-mono); font-size: 10px; font-weight: var(--weight-medium); }
.howto-node { fill: var(--color-surface-subtle); stroke: var(--color-border-strong); stroke-width: 1; }
.howto-node.is-parent { fill: var(--color-accent-soft); }
.howto-link, .howto-track, .howto-line { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.howto-link { stroke-dasharray: 3 4; }
.howto-line { stroke: var(--color-border-strong); stroke-width: 3; }
.howto-actor { fill: var(--color-surface-subtle); stroke: var(--color-border-strong); stroke-width: 1.5; }
.howto-actor.is-lit, .howto-node.is-lit { fill: color-mix(in srgb, var(--color-gold) 22%, var(--color-surface)); stroke: var(--color-gold); }
.howto-hub { fill: color-mix(in srgb, var(--color-gold) 22%, var(--color-surface)); stroke: var(--color-gold); stroke-width: 1.5; }
.howto-hub-mark { fill: var(--color-gold); font-size: 12px; font-weight: var(--weight-strong); }
.howto-slot { fill: none; stroke: var(--color-border-strong); stroke-width: 1.5; stroke-dasharray: 3 3; }
.howto-say, .howto-packet { fill: var(--color-gold); }
.howto-tick { fill: none; stroke: var(--color-success); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 20; }

/* The loop: the bubble types its token, then the scene answers. */
.is-animated .howto-bubble text { animation: howto-type var(--howto-loop) steps(4, end) infinite; }
.is-animated .howto-link { animation: howto-flow var(--howto-loop) linear infinite; animation-delay: calc(var(--i, 0) * var(--howto-step)); }
.is-animated .howto-actor.is-lit, .is-animated .howto-hub { animation: howto-glow var(--howto-loop) var(--motion-ease) infinite; transform-box: fill-box; transform-origin: center; }
.is-animated .howto-say, .is-animated .howto-actor.is-small, .is-animated .howto-line {
  animation: howto-pop var(--howto-loop) var(--motion-ease) infinite both; animation-delay: calc(var(--i, 0) * var(--howto-step));
  transform-box: fill-box; transform-origin: center;
}
.is-animated .howto-packet { animation: howto-relay var(--howto-loop) var(--motion-ease) infinite; }
.is-animated .howto-arrive { animation: howto-pop var(--howto-loop) var(--motion-ease) infinite both; transform-box: fill-box; transform-origin: center; }
.is-animated .howto-tick { animation: howto-draw var(--howto-loop) var(--motion-ease) infinite both; }

@keyframes howto-type { 0% { clip-path: inset(0 100% 0 0); } 30%, 100% { clip-path: inset(0 0 0 0); } }
@keyframes howto-flow { to { stroke-dashoffset: -28; } }
@keyframes howto-glow { 0%, 30% { transform: scale(1); } 45% { transform: scale(1.12); } 60%, 100% { transform: scale(1); } }
@keyframes howto-pop { 0%, 30% { opacity: 0; transform: scale(.6); } 45%, 100% { opacity: 1; transform: scale(1); } }
@keyframes howto-relay { 0%, 25% { transform: translateX(0); } 55% { transform: translateX(40px); } 85%, 100% { transform: translateX(0); } }
@keyframes howto-draw { 0%, 40% { stroke-dashoffset: 20; } 60%, 100% { stroke-dashoffset: 0; } }
</style>
