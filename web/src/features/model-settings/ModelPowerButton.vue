<script setup lang="ts">
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
</script>

<template>
  <RouterLink to="/settings/models" class="model-power" :class="`model-power--${power}`" :style="{ '--power-progress': `${progress}%` }"
    draggable="false" :aria-label="label" :title="label" :data-model-power="power">
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
/* Powered: the bolt turns gold and a warm glow breathes behind it. The UI gold
   tokens, not the logo's colours. Only opacity and transform move, so it stays
   on the compositor. */
.model-power--on, .model-power--filling { color: var(--color-gold); }
.model-power--on:hover, .model-power--filling:hover { color: var(--color-gold); }
.model-power :deep(.core-bolt) { fill: currentColor; }
.model-power--on::before {
  content: ''; position: absolute; inset: 4px; z-index: -1; border-radius: 50%;
  background: radial-gradient(circle, var(--color-glow-gold), transparent 70%);
  animation: model-power-breathe 3.2s ease-in-out infinite;
}
@keyframes model-power-breathe { 0%, 100% { opacity: 0.35; transform: scale(0.86); } 50% { opacity: 1; transform: scale(1.08); } }
/* Indexing: a ring fills with the share of knowledge done. */
.model-power--filling::after {
  content: ''; position: absolute; inset: 3px; border-radius: 50%; pointer-events: none;
  background: conic-gradient(var(--color-gold) var(--power-progress), color-mix(in srgb, var(--color-gold) 18%, transparent) 0);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 2px), black calc(100% - 2px));
}
.model-power-dot {
  position: absolute; top: 6px; right: 6px; width: 7px; height: 7px; border-radius: 50%;
  background: var(--color-danger); box-shadow: 0 1px 4px color-mix(in srgb, var(--color-danger) 28%, transparent);
}
@media (prefers-reduced-motion: reduce) { .model-power--on::before { animation: none; opacity: 0.7; } }
:root[data-motion="reduced"] .model-power--on::before { animation: none; opacity: 0.7; }
</style>
