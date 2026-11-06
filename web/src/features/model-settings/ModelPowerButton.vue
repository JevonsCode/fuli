<script setup lang="ts">
import { useRoute } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { getJson } from '@/api/client'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import { roleName, type ModelRolesPayload } from './model'

// The model entry in the top bar, beside 设置 (Jevons 11-06): one look at the
// bar says whether FULI has a model behind it. With none it is a plain icon in
// the bar's own colour and does not move; powered it turns violet, breathes
// and now and then breaks up like a weak signal; while old knowledge is being
// indexed a ring fills around it; when a connected model's latest call failed,
// or the settings cannot be read, it is red and still. It only reads, every
// minute and when the page comes back into view.
type SemanticStatus = { total: number, done: number, running: boolean }
type Power = 'off' | 'on' | 'filling' | 'problem'

const REFRESH_MS = 60_000
const roles = ref<ModelRolesPayload | null>(null)
const semantic = ref<SemanticStatus | null>(null)
let timer: ReturnType<typeof setInterval> | undefined
let request: AbortController | null = null

const enabled = computed(() => roles.value?.roles.filter(role => role.state === 'enabled').length ?? 0)
const filling = computed(() => {
  const status = semantic.value
  return status && status.running && status.total > 0 && status.done < status.total ? status : null
})
// The connected models whose latest call failed: the button turns red.
const failing = computed(() => (roles.value?.roles ?? []).filter(role => role.state === 'enabled' && role.health?.status === 'failing'))
const power = computed<Power>(() => {
  if (roles.value?.state === 'invalid' || failing.value.length) return 'problem'
  if (filling.value) return 'filling'
  return enabled.value ? 'on' : 'off'
})
const progress = computed(() => (filling.value ? Math.round((filling.value.done / filling.value.total) * 100) : 0))
const label = computed(() => {
  if (power.value === 'problem') {
    return failing.value.length ? t('modelSettings.power.failing', { roles: failing.value.map(role => roleName(role.role)).join('、') })
      : t('modelSettings.power.problem')
  }
  if (power.value === 'filling') return t('modelSettings.power.filling', { done: filling.value!.done, total: filling.value!.total })
  return power.value === 'on' ? t('modelSettings.power.on', { count: enabled.value }) : t('modelSettings.power.off')
})

async function refresh() {
  request?.abort()
  request = new AbortController()
  const { signal } = request
  try {
    roles.value = await getJson<ModelRolesPayload>('/api/model-backends/roles', { signal })
  } catch {
    // The last answer stays; a console that does not answer says so elsewhere.
  }
  try {
    semantic.value = await getJson<SemanticStatus>('/api/semantic/status', { signal })
  } catch {
    semantic.value = null
  }
}
const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }

onMounted(() => {
  void refresh()
  timer = setInterval(refresh, REFRESH_MS)
  document.addEventListener('visibilitychange', onVisible)
})
onBeforeUnmount(() => {
  clearInterval(timer)
  request?.abort()
  document.removeEventListener('visibilitychange', onVisible)
})
// Lit like 设置 is on its own page: the model page is this button's page.
const route = useRoute()
const active = computed(() => route?.path === '/models')
</script>

<template>
  <RouterLink to="/models" class="model-power" :class="[`model-power--${power}`, { 'is-active': active }]" :aria-current="active ? 'page' : undefined" :style="{ '--power-progress': `${progress}%` }"
    draggable="false" :aria-label="label" :title="label" :data-model-power="power">
    <!-- The violet gradient the powered icon is drawn with (referenced from CSS). -->
    <svg class="model-power-defs" width="0" height="0" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="model-power-gradient" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" style="stop-color: var(--color-power-from)" />
          <stop offset="55%" style="stop-color: var(--color-power-mid)" />
          <stop offset="100%" style="stop-color: var(--color-power-to)" />
        </linearGradient>
      </defs>
    </svg>
    <span v-if="active" class="model-power-reticle" aria-hidden="true" data-model-power-reticle />
    <UiIcon name="modelCoreOn" :size="18" />
    <!-- Two copies of the powered icon itself, which tear away from it now and then. -->
    <template v-if="power === 'on'">
      <span class="model-power-split model-power-split--cyan" aria-hidden="true"><UiIcon name="modelCoreOn" :size="18" /></span>
      <span class="model-power-split model-power-split--magenta" aria-hidden="true"><UiIcon name="modelCoreOn" :size="18" /></span>
    </template>
  </RouterLink>
</template>

<style scoped>
.model-power {
  position: relative; display: grid; width: 36px; height: 36px; place-items: center; border-radius: 50%;
  color: var(--color-ink-soft); text-decoration: none; user-select: none; isolation: isolate;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.model-power:hover { color: var(--color-ink); background: var(--color-surface-hover); }
.model-power:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
/* Powered (Jevons 11-06): the icon is drawn in a violet gradient and a violet glow breathes
   behind it, and now and then the signal breaks up (below). It all stays inside the 36px
   button; reduced motion keeps only the still glow. */
.model-power-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.model-power--on, .model-power--filling { color: var(--color-power-mid); }
.model-power--on:hover, .model-power--filling:hover { color: var(--color-power-mid); }
.model-power :deep(.core-bolt) { fill: currentColor; }
.model-power--on > :deep(svg), .model-power--filling > :deep(svg) { stroke: url(#model-power-gradient); }
.model-power--on > :deep(svg .core-bolt), .model-power--filling > :deep(svg .core-bolt) { fill: url(#model-power-gradient); }
.model-power--on::before {
  content: ''; position: absolute; inset: 4px; z-index: -1; border-radius: 50%;
  background: radial-gradient(circle, var(--color-glow-power), transparent 70%);
  animation: model-power-breathe 3.2s ease-in-out infinite;
}
@keyframes model-power-breathe { 0%, 100% { opacity: 0.35; transform: scale(0.86); } 50% { opacity: 1; transform: scale(1.08); } }
/* A bad signal (Jevons 11-06): clean most of the time; about every six seconds, for half a
   second, the icon stutters like a weak broadcast. It blinks out and back, tears into shifted
   slices and splits into cyan and magenta copies of itself, each step a hard digital jump
   (steps), then it is clean again. */
.model-power--on > :deep(svg) { animation: model-power-static 6s steps(1, end) infinite; }
@keyframes model-power-static {
  0%, 9%, 100% { transform: none; clip-path: none; opacity: 1; }
  0.8% { transform: translateX(1.5px); clip-path: inset(0 0 58% 0); opacity: 1; }
  1.6% { transform: none; clip-path: none; opacity: 0.25; }
  2.4% { transform: translateX(-2px) skewX(-10deg); clip-path: inset(36% 0 22% 0); opacity: 1; }
  3.2% { transform: translateX(1px); clip-path: inset(62% 0 0 0); opacity: 0.8; }
  4% { transform: none; clip-path: none; opacity: 0; }
  4.8% { transform: translateX(-1px); clip-path: inset(10% 0 48% 0); opacity: 1; }
  5.6% { transform: none; clip-path: none; opacity: 0.6; }
  6.4% { transform: translateX(2px); clip-path: inset(48% 0 14% 0); opacity: 1; }
  7.2% { transform: scale(1.06); clip-path: none; opacity: 1; }
  8% { transform: none; clip-path: none; opacity: 0.4; }
}
.model-power-split {
  position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; opacity: 0;
  mix-blend-mode: multiply;
}
.model-power-split--cyan { color: var(--color-glitch-cyan); animation: model-power-static-cyan 6s steps(1, end) infinite; }
.model-power-split--magenta { color: var(--color-glitch-magenta); animation: model-power-static-magenta 6s steps(1, end) infinite; }
@keyframes model-power-static-cyan {
  0%, 8.8%, 100% { opacity: 0; transform: none; clip-path: none; }
  0.8% { opacity: 0.9; transform: translateX(-3px); clip-path: inset(40% 0 0 0); }
  1.6% { opacity: 0; }
  2.4% { opacity: 0.9; transform: translate(-2px, 1px); clip-path: inset(0 0 60% 0); }
  3.2% { opacity: 0.7; transform: translateX(-4px); clip-path: inset(55% 0 10% 0); }
  4% { opacity: 0.9; transform: translateX(-1px); clip-path: none; }
  4.8% { opacity: 0; }
  5.6% { opacity: 0.8; transform: translateX(-3px); clip-path: inset(20% 0 45% 0); }
  6.4% { opacity: 0.5; transform: translateX(-1.5px); clip-path: inset(70% 0 0 0); }
  7.2% { opacity: 0; }
  8% { opacity: 0.6; transform: translateX(-1px); clip-path: none; }
}
@keyframes model-power-static-magenta {
  0%, 8.8%, 100% { opacity: 0; transform: none; clip-path: none; }
  0.8% { opacity: 0.9; transform: translateX(3px); clip-path: inset(0 0 45% 0); }
  1.6% { opacity: 0.7; transform: translateX(1px); clip-path: none; }
  2.4% { opacity: 0.9; transform: translate(2px, -1px); clip-path: inset(50% 0 5% 0); }
  3.2% { opacity: 0; }
  4% { opacity: 0.9; transform: translateX(1px); clip-path: none; }
  4.8% { opacity: 0.8; transform: translateX(4px); clip-path: inset(30% 0 35% 0); }
  5.6% { opacity: 0; }
  6.4% { opacity: 0.7; transform: translateX(2px); clip-path: inset(0 0 70% 0); }
  7.2% { opacity: 0.5; transform: translateX(1px); clip-path: none; }
  8% { opacity: 0; }
}
/* On the model page (Jevons 11-06: smaller than a disc, not flat violet): a targeting frame
   locks onto the icon. Four thin cyan-to-violet corner brackets, 26px across, snap in from
   wider; a faint scan line sweeps down through them every few seconds. Transform and opacity
   only; reduced motion keeps the still frame. */
.model-power.is-active, .model-power.is-active:hover { background: transparent; }
.model-power-reticle {
  position: absolute; inset: 5px; z-index: -1; pointer-events: none; overflow: hidden;
  animation: model-power-lock 320ms cubic-bezier(.2, .9, .3, 1.2) both;
}
.model-power-reticle::before {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(135deg, var(--color-reticle-from), var(--color-reticle-to));
  --corner: linear-gradient(#000 0 0);
  -webkit-mask:
    var(--corner) top left / 7px 1.5px, var(--corner) top left / 1.5px 7px,
    var(--corner) top right / 7px 1.5px, var(--corner) top right / 1.5px 7px,
    var(--corner) bottom left / 7px 1.5px, var(--corner) bottom left / 1.5px 7px,
    var(--corner) bottom right / 7px 1.5px, var(--corner) bottom right / 1.5px 7px;
  -webkit-mask-repeat: no-repeat;
  mask:
    var(--corner) top left / 7px 1.5px, var(--corner) top left / 1.5px 7px,
    var(--corner) top right / 7px 1.5px, var(--corner) top right / 1.5px 7px,
    var(--corner) bottom left / 7px 1.5px, var(--corner) bottom left / 1.5px 7px,
    var(--corner) bottom right / 7px 1.5px, var(--corner) bottom right / 1.5px 7px;
  mask-repeat: no-repeat;
}
.model-power-reticle::after {
  content: ''; position: absolute; inset: 0 2px auto; height: 1px; opacity: 0;
  background: linear-gradient(90deg, transparent, var(--color-reticle-from), transparent);
  animation: model-power-scan 4s ease-in-out 600ms infinite;
}
@keyframes model-power-lock { from { opacity: 0; transform: scale(1.45) rotate(45deg); } }
@keyframes model-power-scan {
  0% { opacity: 0; transform: translateY(0); }
  4% { opacity: 0.9; }
  22% { opacity: 0.9; transform: translateY(25px); }
  26%, 100% { opacity: 0; transform: translateY(25px); }
}
/* Indexing: a ring fills with the share of knowledge done. */
.model-power--filling::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--color-power-mid) var(--power-progress), color-mix(in srgb, var(--color-power-mid) 18%, transparent) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
}
/* A connected model that does not answer, or settings that cannot be read: a still red icon. */
.model-power--problem, .model-power--problem:hover { color: var(--color-danger); }
@media (prefers-reduced-motion: reduce) {
  .model-power--on::before { animation: none; opacity: 0.7; }
  .model-power--on > :deep(svg) { animation: none; }
  .model-power-split { display: none; }
  .model-power-reticle, .model-power-reticle::after { animation: none; }
}
:root[data-motion="reduced"] .model-power-reticle, :root[data-motion="reduced"] .model-power-reticle::after { animation: none; }
:root[data-motion="reduced"] .model-power--on::before { animation: none; opacity: 0.7; }
:root[data-motion="reduced"] .model-power--on > :deep(svg) { animation: none; }
:root[data-motion="reduced"] .model-power-split { display: none; }
</style>
