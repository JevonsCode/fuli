<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { patchJson } from '@/api/client'
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
const proposedBy = ref<ConfirmationActor>({ kind: 'import', label: '历史记录' })

const subjectLabel = computed(() =>
  props.item?.profileAspect ? '这条偏好' : '这条知识',
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
      || '该内容由已保留的来源记录支持。'
    quadrantReason.value = basis?.quadrant_reason
      || item.reasoningSummary
      || `该内容在发现时符合“${quadrantLabel(item.originQuadrant)}”：${
        quadrantDescription(item.originQuadrant)
      }`
    proposedBy.value = basis?.proposed_by ?? proposedByFromEvidence(evidence)
    confirmationReason.value = '已核对内容与发现时象限，确认无误。'
    acknowledged.value = false
    localError.value = ''
  },
  { immediate: true },
)

async function confirmKnowledge() {
  const item = props.item
  if (!item || busy.value) return
  if (!item.classificationExplicit) {
    return fail('请先补充发现时象限，再确认这条知识')
  }
  if (!existenceReason.value.trim()) return fail('请说明为什么会有这条知识')
  if (!quadrantReason.value.trim()) return fail('请说明为什么属于当前象限')
  if (!confirmationReason.value.trim()) return fail('请填写确认说明')
  if (!acknowledged.value) return fail('请先确认已经核对内容与发现时象限')

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
            label: '当前用户',
          },
          confirmedAt: new Date().toISOString(),
        },
      },
    )
    store.notify(`${subjectLabel.value}已确认，并记录了确认人和确认时间。`)
    emit('saved')
    emit('close')
  } catch (error) {
    localError.value = error instanceof Error ? error.message : '确认失败'
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

function proposedByFromEvidence(evidence?: EvidenceRecord): ConfirmationActor {
  const application = {
    codex: 'Codex',
    claude_code: 'Claude Code',
    cursor: 'Cursor',
    kiro: 'Kiro',
    other: '其他 Agent',
  }[evidence?.source_application ?? '']
  return application
    ? { kind: 'agent', label: application }
    : { kind: 'import', label: '历史记录' }
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
          <h3>确认{{ subjectLabel }}</h3>
          <p>确认表示你已核对内容与发现时象限；系统会记录当前用户和确认时间。</p>
        </div>
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          关闭
        </button>
      </header>

      <section class="knowledge-confirm-summary">
        <span>{{ item.profileAspect ? '协作偏好' : '知识内容' }}</span>
        <strong>{{ item.title }}</strong>
        <p>{{ item.body }}</p>
        <small>发现时象限 · {{ quadrantLabel(item.originQuadrant) }}</small>
      </section>

      <div class="knowledge-confirm-fields">
        <label>
          <span>为什么会有这条知识</span>
          <textarea
            v-model="existenceReason"
            name="confirmation-existence-reason"
            maxlength="4096"
            rows="3"
            required
          />
        </label>
        <label>
          <span>为什么属于当前象限</span>
          <textarea
            v-model="quadrantReason"
            name="confirmation-quadrant-reason"
            maxlength="4096"
            rows="3"
            required
          />
        </label>
        <label>
          <span>确认说明</span>
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
        <span>我已核对这条内容及其发现时象限，并确认上述依据准确。</span>
      </label>

      <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
      <footer class="project-profile-dialog-actions">
        <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
          取消
        </button>
        <button
          class="primary-action"
          type="submit"
          :disabled="busy || !acknowledged"
        >
          {{ busy ? '正在确认…' : `确认${subjectLabel}` }}
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
