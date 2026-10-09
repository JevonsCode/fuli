<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import UiButton from '@/components/ui/UiButton.vue'
import UiDialog from '@/components/ui/UiDialog.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import {
  batchConfirmationBasis,
  quadrantLabel,
} from '@/features/knowledge/model'
import { t } from '@/i18n'
import { compactIdentity, identitySearchText } from '@/lib/identity'
import { useConsoleStore } from '@/stores/console'
import type {
  KnowledgeConfirmationGroup,
  KnowledgeItem,
} from '@/types'

const props = defineProps<{
  groups: KnowledgeConfirmationGroup[]
  personalSpaceId: string
}>()

const emit = defineEmits<{
  close: []
  saved: []
}>()

const store = useConsoleStore()
const selectedGroupKey = ref('')
const selectedItemKeys = ref<string[]>([])
const confirmerKind = ref('user')
const confirmerLabel = ref('')
const reason = ref('')
const acknowledged = ref(false)
const busy = ref(false)
const localError = ref('')

const groupOptions = computed(() =>
  props.groups.map((group) => ({
    value: group.key,
    label: group.label,
    meta: t('knowledge.dialogs.batch.groupMeta', {
      kind: group.kind === 'source'
        ? t('knowledge.dialogs.batch.sameSource')
        : t('knowledge.dialogs.batch.sameSession'),
      count: group.items.length,
    }),
    search: `${identitySearchText(group.value)} ${group.description}`,
  })),
)
const selectedGroup = computed(() =>
  props.groups.find(({ key }) => key === selectedGroupKey.value) ?? null,
)
const reviewableItems = computed(() => selectedGroup.value?.items.slice(0, 200) ?? [])
const selectedItems = computed(() => {
  const selected = new Set(selectedItemKeys.value)
  return reviewableItems.value.filter((item) => selected.has(itemKey(item)))
})
const allSelected = computed(
  () =>
    reviewableItems.value.length > 0
    && selectedItems.value.length === reviewableItems.value.length,
)
const canSubmit = computed(
  () =>
    !busy.value
    && selectedItems.value.length >= 2
    && Boolean(reason.value.trim())
    && acknowledged.value
    && (
      confirmerKind.value !== 'authoritative_source'
      || Boolean(confirmerLabel.value.trim())
    ),
)
const confirmerOptions = computed(() => [
  { value: 'user', label: t('knowledge.domain.actors.user') },
  {
    value: 'authoritative_source',
    label: t('knowledge.domain.actors.authoritative_source'),
  },
])

watch(
  () => props.groups,
  (groups) => {
    if (!groups.some(({ key }) => key === selectedGroupKey.value)) {
      selectedGroupKey.value = groups[0]?.key ?? ''
    }
  },
  { immediate: true },
)

watch(selectedGroupKey, () => {
  selectedItemKeys.value = reviewableItems.value.map(itemKey)
  acknowledged.value = false
  localError.value = ''
}, { immediate: true })

function itemKey(item: KnowledgeItem) {
  return `${item.itemKind}:${item.id}`
}

function toggleAll() {
  selectedItemKeys.value = allSelected.value
    ? []
    : reviewableItems.value.map(itemKey)
  acknowledged.value = false
}

function basisFor(item: KnowledgeItem) {
  const group = selectedGroup.value
  return group ? batchConfirmationBasis(item, group) : null
}

async function confirmBatch() {
  if (busy.value) return
  const group = selectedGroup.value
  if (!group) return fail(t('knowledge.dialogs.batch.errors.groupRequired'))
  if (selectedItems.value.length < 2) {
    return fail(t('knowledge.dialogs.batch.errors.itemsRequired'))
  }
  if (!reason.value.trim()) return fail(t('knowledge.dialogs.batch.errors.reasonRequired'))
  if (confirmerKind.value === 'authoritative_source' && !confirmerLabel.value.trim()) {
    return fail(t('knowledge.dialogs.batch.errors.sourceNameRequired'))
  }
  if (!acknowledged.value) {
    return fail(t('knowledge.dialogs.batch.errors.acknowledgmentRequired'))
  }

  busy.value = true
  localError.value = ''
  try {
    const result = await postJson<{ confirmed_count: number }>(
      '/api/knowledge/batch-confirmation',
      {
        personalSpaceId: props.personalSpaceId,
        groupKind: group.kind,
        groupValue: group.value,
        reason: reason.value.trim(),
        confirmer: {
          kind: confirmerKind.value,
          label: confirmerLabel.value.trim() || null,
        },
        items: selectedItems.value.map((item) => {
          const basis = basisFor(item)!
          return {
            itemId: item.id,
            itemKind: item.itemKind,
            existenceReason: basis.existenceReason,
            quadrantReason: basis.quadrantReason,
            proposedBy: basis.proposedBy,
          }
        }),
      },
    )
    store.notify(t('knowledge.dialogs.batch.confirmed', {
      count: result.confirmed_count,
    }))
    emit('saved')
    emit('close')
  } catch (error) {
    localError.value = error instanceof Error
      ? error.message
      : t('knowledge.dialogs.batch.errors.failed')
    store.reportError(error)
  } finally {
    busy.value = false
  }
}

function fail(message: string) {
  localError.value = message
}
</script>

<template>
  <UiDialog open class="batch-confirm-dialog" size="xl" form :title="t('knowledge.dialogs.batch.title')"
    :description="t('knowledge.dialogs.batch.intro')" :busy="busy" :error="localError"
    @close="emit('close')" @submit="confirmBatch">
    <div class="batch-confirm-layout">
      <section class="batch-confirm-controls">
        <UiSelect v-model="selectedGroupKey" field :options="groupOptions" :label="t('knowledge.dialogs.batch.range')" searchable />
        <div v-if="selectedGroup" class="batch-group-summary">
          <span class="ui-meta">{{ selectedGroup.kind === 'source' ? t('knowledge.dialogs.batch.sameSource') : t('knowledge.dialogs.batch.sameSession') }}</span>
          <strong>{{ selectedGroup.label }}</strong>
          <p>{{ selectedGroup.description }}</p>
          <small class="ui-meta">#{{ compactIdentity(selectedGroup.value, 28) }}</small>
        </div>
        <div class="batch-confirmer-fields">
          <UiSelect v-model="confirmerKind" field :options="confirmerOptions" :label="t('knowledge.dialogs.batch.confirmer')" />
          <label class="ui-field">{{ t('knowledge.dialogs.batch.confirmerDescription') }}
            <input v-model="confirmerLabel" maxlength="160" :required="confirmerKind === 'authoritative_source'"
              :placeholder="confirmerKind === 'user' ? t('knowledge.dialogs.batch.userPlaceholder') : t('knowledge.dialogs.batch.sourcePlaceholder')" />
          </label>
        </div>
        <label class="ui-field">{{ t('knowledge.dialogs.batch.basis') }}
          <textarea v-model="reason" maxlength="2000" rows="3" required :placeholder="t('knowledge.dialogs.batch.basisPlaceholder')" />
        </label>
        <p class="ui-meta">{{ t('knowledge.dialogs.batch.agentBoundary') }}</p>
      </section>

      <section class="batch-confirm-review">
        <div class="batch-review-heading">
          <div>
            <h3>{{ t('knowledge.dialogs.batch.itemReview') }}</h3>
            <p class="ui-meta">{{ t('knowledge.dialogs.batch.selected', { selected: selectedItems.length, total: reviewableItems.length }) }}</p>
          </div>
          <UiButton size="sm" variant="ghost" @click="toggleAll">
            {{ allSelected ? t('knowledge.dialogs.batch.clearAll') : t('knowledge.dialogs.batch.selectAll') }}
          </UiButton>
        </div>
        <p v-if="(selectedGroup?.items.length ?? 0) > 200" class="ui-meta">{{ t('knowledge.dialogs.batch.limit') }}</p>
        <div class="batch-review-list">
          <label v-for="item in reviewableItems" :key="itemKey(item)" class="batch-review-item">
            <input v-model="selectedItemKeys" type="checkbox" :value="itemKey(item)" />
            <span>
              <strong>{{ item.title }}</strong>
              <small>{{ quadrantLabel(item.originQuadrant) }} · {{ item.type }}</small>
              <em>{{ basisFor(item)?.existenceReason }}</em>
              <em>{{ basisFor(item)?.quadrantReason }}</em>
            </span>
          </label>
        </div>
        <label class="ui-check batch-confirm-acknowledgement">
          <input v-model="acknowledged" type="checkbox" />
          <span>{{ t('knowledge.dialogs.batch.acknowledgment') }}</span>
        </label>
      </section>
    </div>
    <template #footer>
      <UiButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.actions.cancel') }}</UiButton>
      <UiButton variant="primary" type="submit" :disabled="!canSubmit" :busy="busy" :busy-label="t('knowledge.dialogs.batch.confirming')">
        {{ t('knowledge.dialogs.batch.confirmItems', { count: selectedItems.length }) }}
      </UiButton>
    </template>
  </UiDialog>
</template>

<style scoped>
.batch-confirm-layout { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 24px; }
.batch-confirm-controls { display: grid; align-content: start; gap: 14px; }
.batch-group-summary { display: grid; gap: 2px; padding: 10px 12px; border-radius: var(--radius-control); background: var(--color-surface-subtle); font-size: 12px; }
.batch-group-summary p { margin: 0; color: var(--color-muted); line-height: 1.5; }
.batch-confirmer-fields { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 8px; }
.batch-confirm-review { display: grid; align-content: start; gap: 10px; min-width: 0; padding-left: 24px; border-left: 1px solid var(--color-border); }
.batch-review-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.batch-review-heading h3 { margin: 0; font-size: 13px; font-weight: 600; }
.batch-review-list { max-height: 410px; overflow: auto; border-block: 1px solid var(--color-border); }
.batch-review-item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; padding: 10px 2px; border-bottom: 1px solid var(--color-border); cursor: pointer; }
.batch-review-item:last-child { border-bottom: 0; }
.batch-review-item > span { display: grid; gap: 3px; min-width: 0; font-size: 12px; }
.batch-review-item small, .batch-review-item em { color: var(--color-muted); }
.batch-review-item em { overflow: hidden; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
@media (max-width: 820px) {
  .batch-confirm-layout { grid-template-columns: 1fr; }
  .batch-confirm-review { padding: 0; border-left: 0; }
}
</style>
