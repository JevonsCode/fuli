<script setup lang="ts">
import { computed, onMounted, ref, useId, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Switch } from '@/components/ui/switch'
import { currentLocale, t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

import { readDelegation, saveDelegation, type ReviewDelegation } from './review-api'

// 「交给 Tonborg 确认」 (rec#96), the same switch on the 待决策 list and in
// Tonborg's model settings. It runs on Tonborg's own model, so without one it
// cannot be turned on and says where to connect one.
const props = defineProps<{ personalSpaceId: string }>()
const emit = defineEmits<{ changed: [enabled: boolean] }>()
const store = useConsoleStore()
const route = useRoute()
const state = ref<ReviewDelegation | null>(null)
const saving = ref(false)
const id = `tonborg-delegation-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`

async function load() {
  if (!props.personalSpaceId) return
  try { state.value = await readDelegation(props.personalSpaceId) } catch { state.value = null }
  void keepLanguage()
}

// While Tonborg asks for the person, it asks in this console's language: one
// saved before the console sent it, or in another language, is saved again quietly.
async function keepLanguage() {
  const current = state.value
  if (!current?.enabled || current.language === currentLocale() || saving.value) return
  try { state.value = await saveDelegation(props.personalSpaceId, true, current.revision) } catch { /* the next load tries again */ }
}
onMounted(load)
watch(() => props.personalSpaceId, load)

const connected = computed(() => state.value?.model?.connected === true)
const hint = computed(() => {
  if (!state.value) return ''
  if (!connected.value) return t('reviewList.delegation.needsModel')
  return t(state.value.enabled ? 'reviewList.delegation.onHint' : 'reviewList.delegation.offHint')
})

async function change(enabled: boolean) {
  const current = state.value
  if (!current || saving.value) return
  saving.value = true
  try {
    state.value = await saveDelegation(props.personalSpaceId, enabled, current.revision)
    // From Tonborg's settings the toast links to the list it changes; on the list itself it needs none.
    store.notify(t(enabled ? 'reviewList.delegation.on' : 'reviewList.delegation.off'), route?.path === '/inbox' ? undefined : { to: '/inbox' })
    emit('changed', enabled)
  } catch (cause) {
    store.reportError(new Error(apiErrorReason(cause)))
    await load()
  } finally { saving.value = false }
}
</script>

<template>
  <div class="tonborg-delegation" data-tonborg-delegation>
    <div class="tonborg-delegation__row">
      <label :for="id" class="tonborg-delegation__label">{{ t('reviewList.delegation.label') }}</label>
      <span class="tonborg-delegation__busy" :class="{ 'is-shown': saving }">
        <GrowthLoading v-if="saving" variant="inline" :label="t('reviewList.delegation.saving')" />
      </span>
      <Switch :id="id" :model-value="state?.enabled === true" :disabled="!state || !connected || saving"
        @update:model-value="change(Boolean($event))" />
    </div>
    <p v-if="hint" class="tonborg-delegation__hint">
      {{ hint }}
      <RouterLink v-if="state && !connected" to="/models" class="tonborg-delegation__link">{{ t('reviewList.delegation.connect') }}</RouterLink>
    </p>
  </div>
</template>

<style scoped>
.tonborg-delegation { display: grid; gap: 4px; justify-items: end; min-width: 0; }
.tonborg-delegation__row { display: flex; align-items: center; gap: 8px; min-height: var(--control-sm, 30px); }
.tonborg-delegation__label { color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); user-select: none; cursor: pointer; }
/* Reserved, so the switch never moves while a change is saved. */
.tonborg-delegation__busy { display: inline-flex; width: 16px; justify-content: center; }
.tonborg-delegation__hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); text-align: right; }
.tonborg-delegation__link { margin-left: 4px; color: var(--color-primary); user-select: none; }
</style>
