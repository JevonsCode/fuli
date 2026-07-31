<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import { postJson } from '@/api/client'
import SearchableSelect from '@/components/SearchableSelect.vue'
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
  <dialog open class="project-dialog batch-confirm-dialog vue-dialog">
    <div class="project-dialog-shell">
      <header class="project-dialog-header">
        <div>
          <p class="eyebrow">BATCH CONFIRMATION</p>
          <h3>{{ t('knowledge.dialogs.batch.title') }}</h3>
          <p>{{ t('knowledge.dialogs.batch.intro') }}</p>
        </div>
        <button class="secondary-action" type="button" @click="emit('close')">{{ t('common.actions.close') }}</button>
      </header>

      <form class="batch-confirm-form" @submit.prevent="confirmBatch">
        <section class="batch-confirm-controls">
          <label>{{ t('knowledge.dialogs.batch.range') }}
            <SearchableSelect
              v-model="selectedGroupKey"
              :options="groupOptions"
              :label="t('knowledge.dialogs.batch.rangeLabel')"
              searchable
            />
          </label>
          <div v-if="selectedGroup" class="batch-group-summary">
            <span>{{ selectedGroup.kind === 'source'
              ? t('knowledge.dialogs.batch.sameSource')
              : t('knowledge.dialogs.batch.sameSession') }}</span>
            <strong>{{ selectedGroup.label }}</strong>
            <p>{{ selectedGroup.description }}</p>
            <small>#{{ compactIdentity(selectedGroup.value, 28) }}</small>
          </div>
          <div class="batch-confirmer-fields">
            <label>{{ t('knowledge.dialogs.batch.confirmer') }}
              <SearchableSelect
                v-model="confirmerKind"
                :options="confirmerOptions"
                :label="t('knowledge.dialogs.batch.confirmerLabel')"
              />
            </label>
            <label>{{ t('knowledge.dialogs.batch.confirmerDescription') }}
              <input
                v-model="confirmerLabel"
                maxlength="160"
                :required="confirmerKind === 'authoritative_source'"
                :placeholder="confirmerKind === 'user'
                  ? t('knowledge.dialogs.batch.userPlaceholder')
                  : t('knowledge.dialogs.batch.sourcePlaceholder')"
              />
            </label>
          </div>
          <label>{{ t('knowledge.dialogs.batch.basis') }}
            <textarea
              v-model="reason"
              maxlength="2000"
              rows="3"
              required
              :placeholder="t('knowledge.dialogs.batch.basisPlaceholder')"
            />
          </label>
          <p class="batch-confirm-rule">
            {{ t('knowledge.dialogs.batch.agentBoundary') }}
          </p>
        </section>

        <section class="batch-confirm-review">
          <div class="batch-review-heading">
            <div>
              <h4>{{ t('knowledge.dialogs.batch.itemReview') }}</h4>
              <p>{{ t('knowledge.dialogs.batch.selected', {
                selected: selectedItems.length,
                total: reviewableItems.length,
              }) }}</p>
            </div>
            <button class="secondary-action" type="button" @click="toggleAll">
              {{ allSelected
                ? t('knowledge.dialogs.batch.clearAll')
                : t('knowledge.dialogs.batch.selectAll') }}
            </button>
          </div>
          <p v-if="(selectedGroup?.items.length ?? 0) > 200" class="batch-limit-note">
            {{ t('knowledge.dialogs.batch.limit') }}
          </p>
          <div class="batch-review-list">
            <label
              v-for="item in reviewableItems"
              :key="itemKey(item)"
              class="batch-review-item"
            >
              <input v-model="selectedItemKeys" type="checkbox" :value="itemKey(item)" />
              <span>
                <strong>{{ item.title }}</strong>
                <small>{{ quadrantLabel(item.originQuadrant) }} · {{ item.type }}</small>
                <em>{{ basisFor(item)?.existenceReason }}</em>
                <em>{{ basisFor(item)?.quadrantReason }}</em>
              </span>
            </label>
          </div>
          <label class="batch-confirm-acknowledgement">
            <input v-model="acknowledged" type="checkbox" />
            <span>{{ t('knowledge.dialogs.batch.acknowledgment') }}</span>
          </label>
        </section>

        <p v-if="localError" class="publish-dialog-error" role="alert">{{ localError }}</p>
        <div class="publish-dialog-actions">
          <button class="secondary-action" type="button" :disabled="busy" @click="emit('close')">
            {{ t('common.actions.cancel') }}
          </button>
          <button
            class="primary-action"
            type="submit"
            :disabled="!canSubmit"
          >
            {{ busy
              ? t('knowledge.dialogs.batch.confirming')
              : t('knowledge.dialogs.batch.confirmItems', { count: selectedItems.length }) }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>

<style scoped>
.batch-confirm-dialog {
  width: min(980px, calc(100vw - 64px));
}

.batch-confirm-form {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 24px;
  padding-top: 20px;
}

.batch-confirm-controls {
  display: grid;
  align-content: start;
  gap: 14px;
}

.batch-confirm-controls > label,
.batch-confirmer-fields label {
  display: grid;
  gap: 6px;
  color: #5f6962;
  font-size: 10px;
  font-weight: 600;
}

.batch-confirm-controls :deep(.searchable-select) {
  width: 100%;
}

.batch-group-summary {
  display: grid;
  gap: 4px;
  padding: 12px 0;
  border-top: 1px solid #e1e5e2;
  border-bottom: 1px solid #e1e5e2;
}

.batch-group-summary span,
.batch-group-summary small {
  color: #89918b;
  font-size: 8px;
}

.batch-group-summary strong {
  color: #35443b;
  font-size: 12px;
}

.batch-group-summary p {
  color: #6e7871;
  font-size: 9px;
  line-height: 1.5;
}

.batch-confirmer-fields {
  display: grid;
  grid-template-columns: 112px minmax(0, 1fr);
  gap: 8px;
}

.batch-confirm-rule,
.batch-limit-note {
  color: #7c857f;
  font-size: 9px;
  line-height: 1.5;
}

.batch-confirm-review {
  min-width: 0;
  padding-left: 24px;
  border-left: 1px solid #e1e5e2;
}

.batch-review-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 10px;
}

.batch-review-heading h4 {
  color: #344239;
  font-size: 13px;
}

.batch-review-heading p {
  margin-top: 2px;
  color: #858e87;
  font-size: 9px;
}

.batch-review-list {
  max-height: 410px;
  overflow: auto;
  border-top: 1px solid #e3e6e3;
  border-bottom: 1px solid #e3e6e3;
}

.batch-review-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 9px;
  padding: 10px 2px;
  border-bottom: 1px solid #eceeec;
  cursor: pointer;
}

.batch-review-item:last-child {
  border-bottom: 0;
}

.batch-review-item > input {
  margin-top: 2px;
}

.batch-review-item > span {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.batch-review-item strong {
  color: #3a4740;
  font-size: 10px;
}

.batch-review-item small {
  color: #77817a;
  font-size: 8px;
}

.batch-review-item em {
  overflow: hidden;
  color: #848d87;
  font-size: 8px;
  font-style: normal;
  line-height: 1.4;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-confirm-acknowledgement {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  color: #4f5d55;
  font-size: 9px;
  line-height: 1.5;
  cursor: pointer;
}

.batch-confirm-form > .publish-dialog-error,
.batch-confirm-form > .publish-dialog-actions {
  grid-column: 1 / -1;
}

@media (max-width: 820px) {
  .batch-confirm-form {
    grid-template-columns: 1fr;
  }

  .batch-confirm-review {
    padding: 0;
    border-left: 0;
  }
}
</style>
