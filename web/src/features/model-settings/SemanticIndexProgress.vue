<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { getJson, postJson } from '@/api/client'
import { t } from '@/i18n'

// How much of the knowledge the connected model has indexed (rec#88): a row of
// stars that light as the background pass fills the meaning index, the next
// one glowing while a pass runs. Connecting or changing the model starts a
// pass at once. It reads every few seconds while filling, every minute after.
type Status = { model: string | null, total: number, done: number, running: boolean }

const props = defineProps<{ model: string | null }>()
const STARS = 24
const status = ref<Status | null>(null)
let timer: ReturnType<typeof setTimeout> | undefined
let unmounted = false

const shown = computed(() => (status.value && status.value.model && status.value.total > 0 ? status.value : null))
const complete = computed(() => Boolean(shown.value && shown.value.done >= shown.value.total))
const lit = computed(() => (shown.value ? Math.floor((Math.min(shown.value.done, shown.value.total) / shown.value.total) * STARS) : 0))

async function read() {
  clearTimeout(timer)
  try {
    status.value = await getJson<Status>('/api/semantic/status')
  } catch {
    // The last answer stays.
  }
  if (!unmounted) timer = setTimeout(read, status.value?.running ? 4000 : 60_000)
}

async function fill() {
  try {
    status.value = await postJson<Status>('/api/semantic/fill', {})
  } catch {
    // The background pass still runs on its own schedule.
  }
  void read()
}

// A model connected or changed here starts its pass now.
watch(() => props.model, (model, before) => { if (model && model !== before) void fill() })
onMounted(read)
onBeforeUnmount(() => { unmounted = true; clearTimeout(timer) })
</script>

<template>
  <div v-if="shown" class="semantic-progress" :class="{ 'is-running': shown.running }" role="status" data-semantic-progress>
    <span class="semantic-stars" aria-hidden="true">
      <i v-for="star in STARS" :key="star" :class="{ 'is-lit': star <= lit, 'is-next': shown.running && star === lit + 1 }"
        :style="{ '--star': star }" />
    </span>
    <span class="semantic-progress-text">
      {{ complete ? t('modelSettings.semantic.indexDone', { total: shown.total })
        : t('modelSettings.semantic.indexing', { done: shown.done, total: shown.total }) }}
    </span>
  </div>
</template>

<style scoped>
.semantic-progress { display: flex; align-items: center; gap: 10px; min-height: 20px; color: var(--color-muted); font-size: 12px; }
.semantic-stars { display: inline-flex; gap: 3px; }
.semantic-stars i {
  width: 5px; height: 5px; border-radius: 50%; background: color-mix(in srgb, var(--color-gold) 22%, transparent);
  transition: background var(--motion-fast), transform var(--motion-fast);
}
.semantic-stars i.is-lit { background: var(--color-gold); transform: scale(1.15); }
.semantic-stars i.is-next { animation: semantic-star 1.4s ease-in-out infinite; }
@keyframes semantic-star { 0%, 100% { opacity: 0.35; transform: scale(0.9); } 50% { opacity: 1; transform: scale(1.35); } }
@media (prefers-reduced-motion: reduce) { .semantic-stars i.is-next { animation: none; } }
:root[data-motion="reduced"] .semantic-stars i.is-next { animation: none; }
</style>
