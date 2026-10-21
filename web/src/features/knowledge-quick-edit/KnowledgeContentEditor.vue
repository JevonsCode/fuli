<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Textarea } from '@/components/ui/textarea'
import { t } from '@/i18n'
import {
  canReassert, contentRequest, editFailure, markOutdatedRequest, versionStatus, versionStatusLabel,
  type BasisMeaning, type EditFailure, type KnowledgeItemView,
} from './model'
import { reviseItem } from './quick-edit-api'

// rec#5 C7/C8: the item's words and validity. Saving new words writes a new
// version that supersedes this one; marking it outdated ends its validity and
// keeps its history; an outdated item is confirmed again only as a new
// version. Each names the version the page read.
const props = defineProps<{ item: KnowledgeItemView; spaceId: string }>()
const emit = defineEmits<{ saved: []; versioned: [itemId: string, waiting: number]; failed: [reason: EditFailure] }>()

const content = ref(props.item.content)
const reason = ref('')
const outdatedReason = ref('')
const pending = ref<'content' | 'outdated' | null>(null)
// Conclusions rest on it: the person says what the edit means (D-20.7).
const meaning = ref<BasisMeaning>('changed')
const dependents = computed(() => props.item.dependent_count ?? 0)
const message = ref<{ kind: 'error' | 'status'; text: string } | null>(null)
watch(() => [props.item.item_id, props.item.version], () => { content.value = props.item.content; meaning.value = 'changed' })

const current = computed(() => versionStatus(props.item) === 'current')
const reassert = computed(() => canReassert(props.item))
const unchanged = computed(() => content.value.trim() === props.item.content.trim())
// Saying an outdated item again is a new version even with the same words.
const contentBody = computed(() => unchanged.value && !reassert.value ? null
  : contentRequest(props.spaceId, props.item, content.value, reason.value, dependents.value ? meaning.value : null))
const outdatedBody = computed(() => markOutdatedRequest(props.spaceId, props.item, outdatedReason.value))

async function submit(kind: 'content' | 'outdated', body: object | null) {
  if (!body) return
  pending.value = kind
  message.value = null
  try {
    const result = await reviseItem(props.item, body)
    reason.value = ''
    outdatedReason.value = ''
    if (kind === 'content' && result.version_item_id) {
      emit('versioned', result.version_item_id, result.dependents_changed ?? 0)
      return
    }
    const dependents = result.dependents_outdated ?? 0
    message.value = { kind: 'status', text: [t('knowledgeQuickEdit.outdated.done'),
      dependents ? t('knowledgeQuickEdit.outdated.dependents', { count: dependents }) : ''].filter(Boolean).join(' ') }
    emit('saved')
  } catch (error) {
    const failure = editFailure(error)
    message.value = { kind: 'error', text: failure === 'forbidden' ? t('knowledgeQuickEdit.forbidden')
      : failure === 'conflict' ? t('knowledgeQuickEdit.conflict')
        : failure === 'superseded' ? t('knowledgeQuickEdit.supersededConflict') : String((error as Error).message) }
    emit('failed', failure)
  } finally {
    pending.value = null
  }
}
</script>

<template>
  <Card v-if="current || reassert" as="section" :data-content-editor="reassert ? 'reassert' : 'edit'">
    <CardHeader>
      <CardTitle as="h2">{{ reassert ? t('knowledgeQuickEdit.reassert.title') : t('knowledgeQuickEdit.content.title') }}</CardTitle>
      <CardDescription>{{ reassert
        ? t('knowledgeQuickEdit.reassert.help', { status: versionStatusLabel(versionStatus(item)) })
        : t('knowledgeQuickEdit.content.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="submit('content', contentBody)">
      <Field>
        <FieldLabel for="item-content">{{ t('knowledgeQuickEdit.content.label') }}</FieldLabel>
        <Textarea id="item-content" v-model="content" rows="3" maxlength="4096" :disabled="pending !== null" />
        <FieldDescription v-if="unchanged && !reassert">{{ t('knowledgeQuickEdit.content.unchanged') }}</FieldDescription>
      </Field>
      <Field v-if="dependents" data-basis-meaning>
        <FieldLabel id="basis-meaning-label">{{ t('knowledgeQuickEdit.meaning.label', { count: dependents }) }}</FieldLabel>
        <RadioGroup v-model="meaning" aria-labelledby="basis-meaning-label" class="grid gap-2" :disabled="pending !== null">
          <label v-for="choice in (['changed', 'wording_only'] as const)" :key="choice" class="flex items-center gap-2 text-sm"
            :data-meaning-choice="choice">
            <RadioGroupItem :value="choice" />{{ t(`knowledgeQuickEdit.meaning.${choice}`) }}
          </label>
        </RadioGroup>
        <FieldDescription>{{ t(`knowledgeQuickEdit.meaning.${meaning}Help`) }}</FieldDescription>
      </Field>
      <!-- A person's new version is their review of what this waited for. -->
      <p v-if="item.basis_review === 'changed'" class="m-0 text-sm text-muted-foreground" data-settles-review>
        {{ t('knowledgeQuickEdit.basisReview.settles') }}
      </p>
      <Field>
        <FieldLabel for="content-reason">{{ t('knowledgeQuickEdit.content.reason') }}</FieldLabel>
        <Input id="content-reason" v-model="reason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" :disabled="!contentBody" :loading="pending === 'content'"
          :loading-label="reassert ? t('knowledgeQuickEdit.reassert.saving') : t('knowledgeQuickEdit.content.saving')">
          {{ reassert ? t('knowledgeQuickEdit.reassert.save') : t('knowledgeQuickEdit.content.save') }}
        </Button>
      </div>
    </form>
  </Card>
  <Card v-if="current" as="section" data-mark-outdated>
    <CardHeader>
      <CardTitle as="h2">{{ t('knowledgeQuickEdit.outdated.title') }}</CardTitle>
      <CardDescription>{{ t('knowledgeQuickEdit.outdated.help') }}</CardDescription>
    </CardHeader>
    <form class="grid gap-4 px-5" @submit.prevent="submit('outdated', outdatedBody)">
      <Field>
        <FieldLabel for="outdated-reason">{{ t('knowledgeQuickEdit.outdated.reason') }}</FieldLabel>
        <Input id="outdated-reason" v-model="outdatedReason" maxlength="2000" autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div>
        <Button type="submit" variant="destructive" :disabled="!outdatedBody" :loading="pending === 'outdated'"
          :loading-label="t('knowledgeQuickEdit.outdated.running')">{{ t('knowledgeQuickEdit.outdated.action') }}</Button>
      </div>
    </form>
  </Card>
  <p v-if="message" :role="message.kind === 'status' ? 'status' : 'alert'" class="m-0 text-sm"
    :class="message.kind === 'status' ? 'text-success' : 'text-destructive'" data-content-message>{{ message.text }}</p>
</template>
