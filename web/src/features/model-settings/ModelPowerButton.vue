<script setup lang="ts">
import { useRoute } from 'vue-router'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { getJson } from '@/api/client'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'
import type { ModelRolesPayload } from './model'

// The model entry in the top bar, beside 设置 (Jevons 11-06): one look at the
// bar says whether FULI has a model behind it. Unpowered it is a quiet dashed
// core; powered the bolt lights and breathes; while old knowledge is being
// indexed a ring fills around it; a configuration that cannot be read shows a
// dot. It only reads, every minute and when the page comes back into view.
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
const power = computed<Power>(() => {
  if (roles.value?.state === 'invalid') return 'problem'
  if (filling.value) return 'filling'
  return enabled.value ? 'on' : 'off'
})
const progress = computed(() => (filling.value ? Math.round((filling.value.done / filling.value.total) * 100) : 0))
const label = computed(() => {
  if (power.value === 'problem') return t('modelSettings.power.problem')
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
    <UiIcon :name="power === 'off' ? 'modelCore' : 'modelCoreOn'" :size="18" />
    <span v-if="power === 'problem'" class="model-power-dot" aria-hidden="true" />
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
   behind it. About every nine seconds the icon glitches for a third of a second: it slips
   sideways in slices with a cyan/magenta split, and a scan line flashes across the button.
   It all stays inside the 36px button; reduced motion keeps only the still glow. */
.model-power-defs { position: absolute; width: 0; height: 0; overflow: hidden; }
.model-power--on, .model-power--filling { color: var(--color-power-mid); }
.model-power--on:hover, .model-power--filling:hover { color: var(--color-power-mid); }
.model-power :deep(.core-bolt) { fill: currentColor; }
.model-power--on :deep(svg), .model-power--filling :deep(svg) { stroke: url(#model-power-gradient); }
.model-power--on :deep(.core-bolt), .model-power--filling :deep(.core-bolt) { fill: url(#model-power-gradient); }
.model-power--on::before {
  content: ''; position: absolute; inset: 4px; z-index: -1; border-radius: 50%;
  background: radial-gradient(circle, var(--color-glow-power), transparent 70%);
  animation: model-power-breathe 3.2s ease-in-out infinite;
}
@keyframes model-power-breathe { 0%, 100% { opacity: 0.35; transform: scale(0.86); } 50% { opacity: 1; transform: scale(1.08); } }
.model-power--on :deep(svg) { animation: model-power-glitch 9s infinite; }
@keyframes model-power-glitch {
  0%, 3.6%, 100% { transform: none; clip-path: none; filter: none; }
  0.6% { transform: translateX(-1.5px); clip-path: inset(18% 0 52% 0);
    filter: drop-shadow(1.5px 0 var(--color-glitch-cyan)) drop-shadow(-1.5px 0 var(--color-glitch-magenta)); }
  1.2% { transform: translateX(1.5px) skewX(-8deg); clip-path: inset(58% 0 8% 0);
    filter: drop-shadow(-1.5px 0 var(--color-glitch-cyan)) drop-shadow(1.5px 0 var(--color-glitch-magenta)); }
  1.8% { transform: translateX(-0.5px); clip-path: inset(0 0 0 0);
    filter: drop-shadow(1px 0 var(--color-glitch-cyan)) drop-shadow(-1px 0 var(--color-glitch-magenta)); }
  2.4% { transform: translateX(1px) scale(1.06); clip-path: inset(30% 0 30% 0); filter: hue-rotate(60deg); }
  3% { transform: scale(0.97); clip-path: none; filter: none; }
}
.model-power--on::after {
  content: ''; position: absolute; inset: 0; border-radius: 50%; pointer-events: none; overflow: hidden; opacity: 0;
  background: linear-gradient(transparent 46%, color-mix(in srgb, var(--color-glitch-cyan) 70%, transparent) 50%, transparent 54%);
  animation: model-power-scan 9s infinite;
}
@keyframes model-power-scan {
  0%, 0.4%, 3.4%, 100% { opacity: 0; transform: translateY(-45%); }
  0.6% { opacity: 0.9; transform: translateY(-30%); }
  1.6% { opacity: 0.7; transform: translateY(10%); }
  2.8% { opacity: 0.5; transform: translateY(40%); }
}
/* On the model page the button is lit like 设置 on its own: a violet gradient disc, white icon. */
.model-power.is-active, .model-power.is-active:hover {
  color: var(--color-on-accent);
  background: linear-gradient(135deg, var(--color-power-from), var(--color-power-mid) 55%, var(--color-power-to));
}
.model-power.is-active :deep(svg) { stroke: currentColor; }
.model-power.is-active :deep(.core-bolt) { fill: currentColor; }
/* Indexing: a ring fills with the share of knowledge done. */
.model-power--filling::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--color-power-mid) var(--power-progress), color-mix(in srgb, var(--color-power-mid) 18%, transparent) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
}
.model-power-dot {
  position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--color-danger); box-shadow: 0 1px 4px color-mix(in srgb, var(--color-danger) 28%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .model-power--on::before { animation: none; opacity: 0.7; }
  .model-power--on :deep(svg), .model-power--on::after { animation: none; }
}
:root[data-motion="reduced"] .model-power--on::before { animation: none; opacity: 0.7; }
:root[data-motion="reduced"] :is(.model-power--on :deep(svg), .model-power--on::after) { animation: none; }
</style>
