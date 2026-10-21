<script setup lang="ts">
import { computed, ref } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { meaningChangedRequest, type EditFailure, type KnowledgeItemView } from './model'
import { useRevisionAction } from './useRevisionAction'

// D-20.7: the conclusions resting on this item's versions. From any version
// record a person can say later that an edit did change the meaning; those
// conclusions then wait for the person's review.
const props = defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ saved: []; failed: [reason: EditFailure] }>()

const reason = ref('')
const dependents = computed(() => props.item.dependent_count ?? 0)
const body = computed(() => meaningChangedRequest(props.spaceId, props.item, reason.value))
const action = useRevisionAction(() => props.item, {
  done: (result) => {
    reason.value = ''
    emit('saved')
    return t('knowledgeQuickEdit.dependents.done', { count: result.dependents_changed ?? 0 })
  },
  failed: (failure) => emit('failed', failure),
})
</script>

<template>
  <Card v-if="dependents" as="section" data-item-dependents>
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.dependents.title') }}</CardTitle>
      <CardDescription>{{ t('knowledgeQuickEdit.dependents.count', { count: dependents }) }} {{ t('knowledgeQuickEdit.dependents.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="action.submit(body)">
      <Field>
        <FieldLabel for="meaning-reason">{{ t('knowledgeQuickEdit.dependents.reason') }}</FieldLabel>
        <Input id="meaning-reason" v-model="reason" maxlength="2000" autocomplete="off" :disabled="action.pending.value" />
      </Field>
      <div>
        <Button type="submit" variant="outline" :disabled="!body" :loading="action.pending.value"
          :loading-label="t('knowledgeQuickEdit.dependents.running')">{{ t('knowledgeQuickEdit.dependents.action') }}</Button>
      </div>
    </form>
    <p v-if="action.message.value" :role="action.message.value.kind === 'status' ? 'status' : 'alert'" class="m-0 px-5 text-sm"
      :class="action.message.value.kind === 'status' ? 'text-success' : 'text-destructive'" data-review-message>
      {{ action.message.value.text }}
    </p>
  </Card>
</template>
