<script setup lang="ts">
import { computed, ref } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { OptionSelect } from '@/components/ui/select'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { saveRequesterMode } from './visit-request-api'
import { modeName, modesFor } from './visit-request-model'
import type { RequesterMode } from './visit-request-shape'
import { useRequesterModes } from './useRequesterModes'
import { useVisitAwaiting } from './useVisitAwaiting'
import { visitErrorText } from './useVisitDecision'
import { VISIT_REQUESTS_PATH } from './useVisitPeek'

// How far one other computer (or guest link) is trusted: 只能问, 计划, 自动 or
// 完全信任, each with its one line. A change is reversible, so it applies at
// once with no dialog; the floating toast names the computer and says what the
// change did to its open requests. The place that shows it says once that no
// mode merges or pushes (visitRequests.mode.never).
const props = defineProps<{ requesterKey: string; label: string }>()
const emit = defineEmits<{ changed: [] }>()
const store = useConsoleStore()
const modes = useRequesterModes()
const awaiting = useVisitAwaiting()
const saving = ref(false)

const options = computed(() => modesFor(props.requesterKey).map(mode => ({
  value: mode, label: modeName(mode), meta: t(`visitRequests.mode.hints.${mode}`),
})))
const current = computed(() => (modes.loaded.value ? modes.modeOf(props.requesterKey) : ''))

async function choose(value: string) {
  const mode = value as RequesterMode
  if (saving.value || mode === current.value) return
  saving.value = true
  try {
    const { requester, effects } = await saveRequesterMode(props.requesterKey, mode, props.label)
    modes.remember(requester.key, requester.mode)
    const message = t('visitRequests.mode.changed', { computer: requester.label, mode: modeName(requester.mode) })
      + (effects.cancelled.length ? t('visitRequests.mode.cancelled', { count: effects.cancelled.length }) : '')
      + (effects.returned.length ? t('visitRequests.mode.returned', { count: effects.returned.length }) : '')
    store.notify(message, { to: VISIT_REQUESTS_PATH })
    if (effects.cancelled.length || effects.returned.length) void awaiting.load()
    emit('changed')
  } catch (error) {
    store.reportError(new Error(visitErrorText(error)))
  } finally { saving.value = false }
}
</script>

<template>
  <div class="requester-mode" data-requester-mode :data-requester="requesterKey">
    <!-- A requester with one possible mode (a guest link: 只能问) gets its name, not a select with one option. -->
    <span v-if="options.length === 1" class="requester-mode-fixed" data-requester-mode-fixed>{{ options[0]!.label }}</span>
    <OptionSelect v-else size="sm" :model-value="current" :options="options" :label="t('visitRequests.mode.label')"
      :disabled="saving || !modes.loaded.value" @update:model-value="choose" />
    <!-- Over the control's own arrow, so nothing moves while the change is saved. -->
    <GrowthLoading v-if="saving" variant="inline" class="requester-mode-saving" :label="t('visitRequests.mode.saving')" />
  </div>
</template>

<style scoped>
.requester-mode { position: relative; width: 132px; flex: none; }
.requester-mode-fixed { display: flex; align-items: center; min-height: var(--control-height-sm); color: var(--color-muted); font-size: var(--text-meta); }
.requester-mode-saving { position: absolute; top: 50%; right: 6px; transform: translateY(-50%); pointer-events: none; }
.requester-mode-saving :deep(.growth-loading__label) { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
