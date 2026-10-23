<script setup lang="ts">
import { computed, ref } from 'vue'

import { apiErrorCode, apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { currentLocale, t } from '@/i18n'

import {
  evaluationText, roleName, saveRoleTrust, trustStatusText,
  type ModelRoleId, type ModelRolesPayload, type RoleTrust, type RoleTrustChange,
} from './model'

// rec#10 D-36: on a role card whose model may carry out an operation by
// itself, who executes now, the person's 「只给建议」 switch with the one-line
// warning beside it, the acknowledgement that the warning was read (the only
// way it counts as seen), and the latest local evaluation when there is one.
const props = defineProps<{ role: ModelRoleId; trust: RoleTrust; model: string | null }>()
const emit = defineEmits<{ saved: [payload: ModelRolesPayload]; changed: [] }>()

const pending = ref<'mode' | 'acknowledge' | null>(null)
const error = ref('')
const name = computed(() => roleName(props.role))
const switchId = computed(() => `model-trust-${props.role}`)
const evaluation = computed(() => evaluationText(props.trust.evaluation, currentLocale()))

async function save(change: RoleTrustChange, kind: 'mode' | 'acknowledge') {
  pending.value = kind
  error.value = ''
  try {
    emit('saved', await saveRoleTrust(props.role, change, props.trust.revision))
  } catch (cause) {
    if (apiErrorCode(cause) === 'model_trust_changed') {
      error.value = t('modelSettings.trust.changed', { name: name.value })
      emit('changed')
    } else {
      error.value = apiErrorReason(cause)
    }
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <section class="model-role-trust grid gap-2 border-t pt-3" :data-model-trust="role" :aria-label="t('modelSettings.trust.label')">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p class="m-0 min-w-0 text-sm" data-model-trust-status>{{ trustStatusText(trust, model) }}</p>
      <div class="flex items-center gap-2">
        <Switch :id="switchId" :model-value="trust.suggestionsOnly" :disabled="pending !== null" data-model-trust-switch
          @update:model-value="(value: boolean) => save({ suggestionsOnly: value }, 'mode')" />
        <Label :for="switchId" class="text-sm">{{ t('modelSettings.trust.suggestionsOnly') }}</Label>
      </div>
    </div>
    <p class="m-0 text-xs leading-relaxed text-muted-foreground" data-model-trust-warning>{{ t('modelSettings.trust.warning') }}</p>
    <div v-if="!trust.warningSeen">
      <Button size="sm" variant="outline" data-model-trust-acknowledge :disabled="pending !== null"
        :loading="pending === 'acknowledge'" :loading-label="t('modelSettings.trust.acknowledging', { name })"
        @click="save({ acknowledgeWarning: trust.warningVersion }, 'acknowledge')">
        {{ t('modelSettings.trust.acknowledge') }}
      </Button>
    </div>
    <p v-if="evaluation" class="m-0 text-xs text-muted-foreground" data-model-trust-evaluation>{{ evaluation }}</p>
    <GrowthLoading v-if="pending === 'mode'" variant="inline" :label="t('modelSettings.trust.saving', { name })" />
    <p v-if="error" class="m-0 text-xs text-destructive" role="alert">{{ error }}</p>
  </section>
</template>
