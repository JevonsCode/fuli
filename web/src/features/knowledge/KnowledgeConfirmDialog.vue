<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { patchJson } from '@/api/client'
import { Button } from '@/components/ui/button'
import UiDialog from '@/ui/UiDialog.vue'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConfirmationActor, EvidenceRecord, KnowledgeItem } from '@/types'
import { quadrantDescription, quadrantLabel } from './model'
import { useKnowledgeWriteLifecycle } from './knowledge-write-lifecycle'

const props = defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
  accessDenied: []
  reload: []
}>()

const store = useConsoleStore()
const existenceReason = ref('')
const quadrantReason = ref('')
const confirmationReason = ref('')
const acknowledged = ref(false)
const accessRevoked = ref(false)
const { busy, takingLong, locked, error: requestError, run } = useKnowledgeWriteLifecycle(() => props.item ? `${props.personalSpaceId}:${props.item.itemKind}:${props.item.id}` : '', () => { accessRevoked.value = true; emit('accessDenied'); emit('close') }, () => [props.personalProjectId, props.item])
const localError = ref('')
const proposedBy = ref<ConfirmationActor>({
  kind: 'import',
  label: t('knowledge.domain.actors.historicalRecord'),
})

const subjectLabel = computed(() =>
  props.item?.profileAspect
    ? t('knowledge.dialogs.confirm.preferenceSubject')
    : t('knowledge.dialogs.confirm.knowledgeSubject'),
)

watch(
  () => [props.item, props.personalSpaceId, props.personalProjectId] as const,
  ([item]) => {
    accessRevoked.value = false;
    if (!item) { existenceReason.value = ''; quadrantReason.value = ''; confirmationReason.value = ''; acknowledged.value = false; localError.value = ''; return }
    const evidence = item.evidence.at(0)
    const basis = item.confirmationBasis
    existenceReason.value = basis?.existence_reason
      || evidence?.source_description
      || evidence?.summary
      || t('knowledge.dialogs.confirm.sourceSupport')
    quadrantReason.value = basis?.quadrant_reason
      || item.reasoningSummary
      || t('knowledge.dialogs.confirm.quadrantReason', {
        quadrant: quadrantLabel(item.originQuadrant),
        description: quadrantDescription(item.originQuadrant),
      })
    proposedBy.value = basis?.proposed_by ?? proposedByFromEvidence(evidence)
    confirmationReason.value = t('knowledge.dialogs.confirm.confirmationReason')
    acknowledged.value = false
    localError.value = ''
  },
  { immediate: true },
)

async function confirmKnowledge() {
  const item = props.item
  if (!item || busy.value) return
  if (!item.classificationExplicit) {
    return fail(t('knowledge.dialogs.confirm.errors.quadrantRequired'))
  }
  if (!existenceReason.value.trim()) {
    return fail(t('knowledge.dialogs.confirm.errors.existenceRequired'))
  }
  if (!quadrantReason.value.trim()) {
    return fail(t('knowledge.dialogs.confirm.errors.quadrantReasonRequired'))
  }
  if (!confirmationReason.value.trim()) {
    return fail(t('knowledge.dialogs.confirm.errors.confirmationReasonRequired'))
  }
  if (!acknowledged.value) {
    return fail(t('knowledge.dialogs.confirm.errors.acknowledgmentRequired'))
  }

  localError.value = ''
  const personalSpaceId = props.personalSpaceId
  const personalProjectId = props.personalProjectId
  await run(async () => {
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      {
        personalSpaceId,
        personalProjectId,
        action: 'confirm',
        reason: confirmationReason.value.trim(),
        confirmationStatus: 'confirmed',
        confirmationBasis: {
          existenceReason: existenceReason.value.trim(),
          quadrantReason: quadrantReason.value.trim(),
          proposedBy: proposedBy.value,
          confirmedBy: {
            kind: 'user',
            label: t('knowledge.domain.actors.currentUser'),
          },
          confirmedAt: new Date().toISOString(),
        },
      },
    )
  }, () => {
    store.notify(t('knowledge.dialogs.confirm.confirmed', {
      subject: subjectLabel.value,
    }))
    emit('saved')
    emit('close')
  })
}

function proposedByFromEvidence(evidence?: EvidenceRecord): ConfirmationActor {
  const application = {
    codex: 'Codex',
    claude: 'Claude',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: t('knowledge.domain.actors.otherAgent'),
  }[evidence?.source_application ?? '']
  return application
    ? { kind: 'agent', label: application }
    : { kind: 'import', label: t('knowledge.domain.actors.historicalRecord') }
}

function fail(message: string) {
  localError.value = message
  document.querySelector<HTMLElement>('.knowledge-confirm-dialog textarea:invalid, .knowledge-confirm-dialog input:invalid, .knowledge-confirm-dialog textarea')?.focus()
}
</script>

<template>
  <p v-if="accessRevoked" role="alert">{{ t('preferences.detail.accessDenied') }}</p>
  <UiDialog v-if="item && !accessRevoked" open class="knowledge-confirm-dialog" size="lg" form
    :title="t('knowledge.dialogs.confirm.title', { subject: subjectLabel })"
    :description="t('knowledge.dialogs.confirm.intro')"
    :busy="busy" :error="localError || requestError" @close="emit('close')" @submit="confirmKnowledge">
    <Button variant="outline" v-if="locked && !busy" data-knowledge-reload @click="emit('reload')">{{ t('preferences.detail.reload') }}</Button>
    <p v-if="takingLong" role="status">{{ t('preferences.detail.writeLong', { action: t('knowledge.dialogs.confirm.confirming', { subject: subjectLabel }) }) }}</p>
    <section class="knowledge-confirm-summary">
      <span class="ui-meta">{{ item.profileAspect ? t('knowledge.dialogs.confirm.preference') : t('knowledge.dialogs.confirm.knowledge') }}</span>
      <strong>{{ item.title }}</strong>
      <p>{{ item.body }}</p>
      <small class="ui-meta">{{ t('knowledge.dialogs.confirm.quadrant', { quadrant: quadrantLabel(item.originQuadrant) }) }}</small>
    </section>
    <label class="ui-field">{{ t('knowledge.dialogs.confirm.whyExists') }}
      <textarea v-model="existenceReason" name="confirmation-existence-reason" maxlength="4096" rows="3" required />
    </label>
    <label class="ui-field">{{ t('knowledge.dialogs.confirm.whyQuadrant') }}
      <textarea v-model="quadrantReason" name="confirmation-quadrant-reason" maxlength="4096" rows="3" required />
    </label>
    <label class="ui-field">{{ t('knowledge.dialogs.confirm.confirmationCopy') }}
      <textarea v-model="confirmationReason" name="confirmation-reason" maxlength="2000" rows="2" required />
    </label>
    <label class="ui-check">
      <input v-model="acknowledged" name="confirmation-acknowledged" type="checkbox" />
      <span>{{ t('knowledge.dialogs.confirm.acknowledgment') }}</span>
    </label>
    <template #footer>
      <Button variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</Button>
      <Button type="submit" :disabled="!acknowledged || locked" :loading="busy" :loading-label="t('knowledge.dialogs.confirm.confirming', { subject: subjectLabel })">
        {{ t('knowledge.dialogs.confirm.confirmSubject', { subject: subjectLabel }) }}
      </Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.knowledge-confirm-summary { display: grid; gap: 4px; padding: 12px 14px; border-radius: var(--radius-control); background: var(--color-surface-subtle); }
.knowledge-confirm-summary strong { font-size: 15px; }
.knowledge-confirm-summary p { margin: 0; color: var(--color-ink-soft); font-size: 13px; line-height: 1.6; }
</style>
