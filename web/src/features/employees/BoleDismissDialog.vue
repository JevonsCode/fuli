<script setup lang="ts">
import { computed, ref } from 'vue'
import { postJson } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import UiDialog from '@/ui/UiDialog.vue'
import { t } from '@/i18n'
import { dismissalReceiptShape, dismissalRefusal, lessonLines, lessonsFit, textFits } from './bole-dismissal'

// The written reason is the confirmation: there is no second step after it.
const props = defineProps<{ personalSpaceId: string; agentId: string; name: string }>()
const emit = defineEmits<{ close: []; dismissed: [] }>()

const reason = ref('')
const lessonText = ref('')
const busy = ref(false)
const error = ref('')
const lessons = computed(() => lessonLines(lessonText.value))
const lessonsValid = computed(() => lessonsFit(lessons.value))
const ready = computed(() => textFits(reason.value) && lessonsValid.value)

async function dismiss() {
  if (!ready.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    await postJson(`/api/project-agents/${encodeURIComponent(props.agentId)}/dismissal`, {
      personalSpaceId: props.personalSpaceId,
      reason: reason.value.trim(),
      ...(lessons.value.length ? { lessons: lessons.value } : {}),
    }, dismissalReceiptShape)
    emit('dismissed')
  } catch (cause) {
    error.value = dismissalRefusal(cause)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiDialog open form :title="t('employees.bole.dismissal.title', { name })" :description="t('employees.bole.dismissal.effect')"
    :busy="busy" :error="error" @close="emit('close')" @submit="dismiss">
    <div class="bole-dismiss-fields">
      <Field>
        <FieldLabel for="bole-dismiss-reason">{{ t('employees.bole.dismissal.reason') }}</FieldLabel>
        <Textarea id="bole-dismiss-reason" v-model="reason" rows="3" maxlength="1000" required autofocus :disabled="busy" />
        <FieldDescription>{{ t('employees.bole.dismissal.reasonHint') }}</FieldDescription>
      </Field>
      <Field :data-invalid="!lessonsValid || undefined">
        <FieldLabel for="bole-dismiss-lessons">{{ t('employees.bole.dismissal.lessons') }}</FieldLabel>
        <Textarea id="bole-dismiss-lessons" v-model="lessonText" rows="3" :aria-invalid="!lessonsValid || undefined" :disabled="busy" />
        <FieldDescription>{{ t('employees.bole.dismissal.lessonsHint') }}</FieldDescription>
        <FieldError v-if="!lessonsValid">{{ t('employees.bole.dismissal.lessonsInvalid') }}</FieldError>
      </Field>
    </div>
    <template #footer>
      <Button variant="outline" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</Button>
      <Button type="submit" variant="destructive" :disabled="!ready" :loading="busy"
        :loading-label="t('employees.bole.dismissal.pending', { name })">{{ t('employees.bole.dismissal.action') }}</Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.bole-dismiss-fields { display: grid; gap: 16px; }
</style>
