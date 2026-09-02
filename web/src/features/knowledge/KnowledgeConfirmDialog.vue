<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { patchJson } from '@/api/client'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import type { ConfirmationActor, EvidenceRecord, KnowledgeItem } from '@/types'
import { quadrantDescription, quadrantLabel } from './model'

const props = defineProps<{
  item: KnowledgeItem | null
  personalSpaceId: string
  personalProjectId: string | null
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useConsoleStore()
const existenceReason = ref('')
const quadrantReason = ref('')
const confirmationReason = ref('')
const acknowledged = ref(false)
const busy = ref(false)
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
  () => props.item,
  (item) => {
    if (!item) return
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

  busy.value = true
  localError.value = ''
  try {
    await patchJson(
      `/api/knowledge/${item.itemKind}/${encodeURIComponent(item.id)}`,
      {
        personalSpaceId: props.personalSpaceId,
        personalProjectId: props.personalProjectId,
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
    store.notify(t('knowledge.dialogs.confirm.confirmed', {
      subject: subjectLabel.value,
    }))
    emit('saved')
    emit('close')
  } catch (error) {
    localError.value = error instanceof Error
      ? error.message
      : t('knowledge.dialogs.confirm.errors.failed')
    store.reportError(error)
  } finally {
    busy.value = false
  }
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
}
</script>

<template>
  <dialog v-if="item" open class="knowledge-confirm-dialog vue-dialog">
    <form class="knowledge-confirm-dialog-shell" @submit.prevent="confirmKnowledge">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">KNOWLEDGE CONFIRMATION</p>
          <h3>{{ t('knowledge.dialogs.confirm.title', { subject: subjectLabel }) }}</h3>
          <p>{{ t('knowledge.dialogs.confirm.intro') }}</p>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.close') }}
        </button>
      </header>

      <section class="knowledge-confirm-summary">
        <span>{{ item.profileAspect
          ? t('knowledge.dialogs.confirm.preference')
          : t('knowledge.dialogs.confirm.knowledge') }}</span>
        <strong>{{ item.title }}</strong>
        <p>{{ item.body }}</p>
        <small>{{ t('knowledge.dialogs.confirm.quadrant', {
          quadrant: quadrantLabel(item.originQuadrant),
        }) }}</small>
      </section>

      <div class="knowledge-confirm-fields">
        <label>
          <span>{{ t('knowledge.dialogs.confirm.whyExists') }}</span>
          <textarea
            v-model="existenceReason"
            name="confirmation-existence-reason"
            maxlength="4096"
            rows="3"
            required
          />
        </label>
        <label>
          <span>{{ t('knowledge.dialogs.confirm.whyQuadrant') }}</span>
          <textarea
            v-model="quadrantReason"
            name="confirmation-quadrant-reason"
            maxlength="4096"
            rows="3"
            required
          />
        </label>
        <label>
          <span>{{ t('knowledge.dialogs.confirm.confirmationCopy') }}</span>
          <textarea
            v-model="confirmationReason"
            name="confirmation-reason"
            maxlength="2000"
            rows="2"
            required
          />
        </label>
      </div>

      <label class="knowledge-confirm-acknowledgement">
        <input v-model="acknowledged" name="confirmation-acknowledged" type="checkbox" />
        <span>{{ t('knowledge.dialogs.confirm.acknowledgment') }}</span>
      </label>

      <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
      <footer class="project-profile-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          {{ t('common.actions.cancel') }}
        </button>
        <button
          class="primary-action"
          type="submit"
          :disabled="busy || !acknowledged"
        >
          {{ busy
            ? t('knowledge.dialogs.confirm.confirming')
            : t('knowledge.dialogs.confirm.confirmSubject', { subject: subjectLabel }) }}
        </button>
      </footer>
    </form>
  </dialog>
</template>

<style scoped>
.knowledge-confirm-dialog {
  width: min(680px, calc(100vw - 48px));
}

.knowledge-confirm-dialog-shell {
  display: grid;
  gap: 18px;
  padding: 24px;
}

.knowledge-confirm-summary {
  display: grid;
  gap: 6px;
  padding: 14px 0;
  border-top: 1px solid #e1e5e2;
  border-bottom: 1px solid #e1e5e2;
}

.knowledge-confirm-summary span,
.knowledge-confirm-summary small {
  color: #7d8780;
  font-size: 10px;
}

.knowledge-confirm-summary strong {
  color: #29382f;
  font-size: 16px;
}

.knowledge-confirm-summary p {
  color: #606b63;
  font-size: 12px;
  line-height: 1.65;
}

.knowledge-confirm-fields {
  display: grid;
  gap: 14px;
}

.knowledge-confirm-fields label {
  display: grid;
  gap: 6px;
  color: #59645c;
  font-size: 11px;
  font-weight: 600;
}

.knowledge-confirm-acknowledgement {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  color: #4e5c53;
  font-size: 11px;
  line-height: 1.5;
}
</style>
