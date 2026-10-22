<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { ApiError, apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'
import {
  governanceRequest, previewLines, refusalCode,
  type GovernanceChange, type GovernancePreview, type RelationKind, type SplitChoice, type TagDetail, type TagEntry,
  type TagLinkedItem, type TagRef,
} from './model'
import TagPicker from './TagPicker.vue'
import { applyGovernance, previewGovernance } from './tags-api'

// One governance change of one tag (rec#11 D-07 part 2): the person chooses
// what the change needs, the Provider previews it, and the confirm names that
// preview's digest. A vocabulary that changed in between is refused and
// previewed again; nothing is applied from a stale preview.
const PREVIEW_DELAY_MS = 300
const props = defineProps<{
  spaceId: string
  detail: TagDetail
  change: GovernanceChange
  initialTarget?: TagRef | null
  initialRelation?: RelationKind
  // Continue an unfinished split-back of a merge (or start one) on this tag.
  initialRestore?: TagRef | null
  alias?: string
  operationId?: string
}>()
const emit = defineEmits<{ done: []; back: [] }>()

const tag = computed(() => props.detail.tag)
const target = ref<TagRef | null>(props.initialTarget ?? null)
const relation = ref<RelationKind>(props.initialRelation ?? 'parent')
const split = ref<SplitChoice>(props.initialRestore
  ? { name: props.initialRestore.name, description: '', aliases: [], links: [], restoreTagId: props.initialRestore.id }
  : { name: '', description: '', aliases: [], links: [] })
const reason = ref(t('knowledgeTags.governance.defaultReason'))
const preview = ref<GovernancePreview | null>(null)
const previewing = ref(false)
const previewError = ref('')
const applying = ref(false)
const notice = ref<{ kind: 'status' | 'alert'; text: string } | null>(null)
let previewRequest = 0

const request = computed(() => governanceRequest(props.change, tag.value, { target: target.value, relation: relation.value,
  alias: props.alias, operationId: props.operationId, split: split.value }))
const ready = computed(() => Boolean(request.value && preview.value && !preview.value.blocked && reason.value.trim()
  && !previewing.value))
const lines = computed(() => preview.value ? previewLines(preview.value) : [])
const names = computed(() => ({ name: tag.value.name, other: preview.value?.other?.name ?? preview.value?.new_tag_name ?? '' }))
const choosesTarget = computed(() => props.change === 'merge' || props.change === 'relate')

// A merge target or parent is personal or of the tag's own namespace; related tags never join two projects.
function allows(candidate: TagEntry) {
  if (candidate.id === tag.value.id) return false
  const sameScope = candidate.namespace === tag.value.namespace && candidate.project_id === tag.value.project_id
  if (props.change === 'relate' && relation.value === 'related') {
    return sameScope || candidate.namespace === 'personal' || tag.value.namespace === 'personal'
  }
  return sameScope || candidate.namespace === 'personal'
}

async function loadPreview() {
  const body = request.value
  const current = ++previewRequest
  if (!body) { preview.value = null; previewing.value = false; return }
  previewing.value = true
  previewError.value = ''
  try {
    const value = await previewGovernance(props.spaceId, body)
    if (current === previewRequest) preview.value = value
  } catch (cause) {
    if (current === previewRequest) { preview.value = null; previewError.value = apiErrorReason(cause) }
  } finally {
    if (current === previewRequest) previewing.value = false
  }
}

const debounced = createDebouncedAction(() => void loadPreview(), PREVIEW_DELAY_MS)
watch(() => JSON.stringify(request.value), () => { preview.value = null; debounced.schedule() })
onBeforeUnmount(() => debounced.cancel())
void loadPreview()

function toggleAlias(alias: string, on: boolean | 'indeterminate') {
  const aliases = split.value.aliases.filter(value => value !== alias)
  split.value = { ...split.value, aliases: on === true ? [...aliases, alias] : aliases }
}

function toggleLink(link: TagLinkedItem, on: boolean | 'indeterminate') {
  const links = split.value.links.filter(value => value.item_id !== link.item_id || value.item_kind !== link.item_kind)
  split.value = { ...split.value, links: on === true ? [...links, link] : links }
}

// G4-5: a mistaken merge is split back under the merged tag's name. The Provider
// moves every item that merge took, from the merge's own record, not from the
// detail's first page of links; a large one comes back in labelled batches.
function restore(merged: TagRef) {
  split.value = { ...split.value, name: merged.name, links: [], restoreTagId: merged.id }
}

function splitByHand() {
  split.value = { ...split.value, name: '', links: [], restoreTagId: undefined }
}

async function confirm() {
  const body = request.value
  const shown = preview.value
  if (!body || !shown || !ready.value || applying.value) return
  applying.value = true
  notice.value = null
  try {
    await applyGovernance(props.spaceId, body, shown, reason.value.trim())
    emit('done')
  } catch (cause) {
    if (cause instanceof ApiError && cause.status === 409 && refusalCode(cause.detail) === 'preview_stale') {
      await loadPreview()
      notice.value = { kind: 'alert', text: t('knowledgeTags.governance.stale') }
    } else if (cause instanceof ApiError && cause.status === 403) {
      notice.value = { kind: 'alert', text: t('knowledgeTags.governance.forbidden') }
    } else {
      notice.value = { kind: 'alert', text: t('knowledgeTags.governance.failed', { error: apiErrorReason(cause) }) }
      await loadPreview()
    }
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <form class="grid min-w-0 gap-4" :data-tag-governance="change" @submit.prevent="confirm">
    <DialogHeader>
      <DialogTitle class="[overflow-wrap:anywhere]">{{ t(`knowledgeTags.governance.titles.${change}`, { name: tag.name }) }}</DialogTitle>
      <DialogDescription>{{ t(`knowledgeTags.governance.hints.${change}`) }}</DialogDescription>
    </DialogHeader>

    <fieldset v-if="change === 'relate'" class="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend class="mb-2 text-sm font-medium">{{ t('knowledgeTags.governance.relation') }}</legend>
      <RadioGroup v-model="relation" class="grid gap-2" :aria-label="t('knowledgeTags.governance.relation')">
        <label v-for="kind in (['parent', 'related'] as const)" :key="kind" class="flex items-center gap-2 text-sm">
          <RadioGroupItem :value="kind" :data-tag-relation="kind" />
          <span>{{ t(`knowledgeTags.governance.relationKinds.${kind}`) }}</span>
        </label>
      </RadioGroup>
    </fieldset>

    <TagPicker v-if="choosesTarget" v-model="target" :space-id="spaceId" :label="t('knowledgeTags.governance.target')"
      :allows="allows" />

    <template v-if="change === 'split'">
      <div v-if="detail.merged_from.length || detail.unfinished_restores.length" class="flex min-w-0 flex-wrap gap-2"
        data-tag-split-restore>
        <Button v-for="merged in detail.merged_from" :key="merged.id" type="button" variant="outline" size="sm"
          :data-tag-restore="merged.id" @click="restore(merged)">
          {{ t('knowledgeTags.governance.splitRestore', { name: merged.name }) }}
        </Button>
        <Button v-for="entry in detail.unfinished_restores" :key="entry.tag.id" type="button" variant="outline" size="sm"
          :data-tag-restore="entry.tag.id" @click="restore(entry.tag)">
          {{ t('knowledgeTags.continueRestore', { name: entry.tag.name, count: entry.remaining }) }}
        </Button>
      </div>
      <p v-if="split.restoreTagId" class="m-0 flex flex-wrap items-center gap-2 text-sm" data-tag-split-restoring>
        <span>{{ t('knowledgeTags.governance.restoreNote', { name: split.name }) }}</span>
        <Button type="button" variant="link" size="sm" class="h-auto p-0" @click="splitByHand">
          {{ t('knowledgeTags.governance.splitByHand') }}
        </Button>
      </p>
      <Field v-else>
        <FieldLabel for="tag-split-name">{{ t('knowledgeTags.governance.splitName') }}</FieldLabel>
        <Input id="tag-split-name" v-model="split.name" maxlength="80" autocomplete="off" data-tag-split-name />
      </Field>
      <Field v-if="!split.restoreTagId">
        <FieldLabel for="tag-split-description">{{ t('knowledgeTags.governance.splitDescription') }}</FieldLabel>
        <Input id="tag-split-description" v-model="split.description" maxlength="500" autocomplete="off" />
      </Field>
      <fieldset class="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend class="mb-2 text-sm font-medium">{{ t('knowledgeTags.governance.splitAliases') }}</legend>
        <p v-if="!tag.aliases.length" class="m-0 text-sm text-muted-foreground">{{ t('knowledgeTags.governance.noAliases') }}</p>
        <label v-for="alias in tag.aliases" :key="alias" class="flex min-w-0 items-center gap-2 text-sm">
          <Checkbox :model-value="split.aliases.includes(alias)" :data-tag-split-alias="alias"
            @update:model-value="value => toggleAlias(alias, value)" />
          <span class="[overflow-wrap:anywhere]">{{ alias }}</span>
        </label>
      </fieldset>
      <fieldset v-if="!split.restoreTagId" class="m-0 grid min-w-0 gap-2 border-0 p-0">
        <legend class="mb-2 text-sm font-medium">{{ t('knowledgeTags.governance.splitLinks') }}</legend>
        <p v-if="!detail.links?.length" class="m-0 text-sm text-muted-foreground">{{ t('knowledgeTags.detail.noLinks') }}</p>
        <ul v-else class="m-0 grid max-h-56 list-none gap-2 overflow-y-auto p-0">
          <li v-for="link in detail.links" :key="`${link.item_kind}:${link.item_id}`" class="min-w-0">
            <label class="flex min-w-0 items-start gap-2 text-sm">
              <Checkbox class="mt-0.5" :data-tag-split-link="link.item_id"
                :model-value="split.links.some(value => value.item_id === link.item_id && value.item_kind === link.item_kind)"
                @update:model-value="value => toggleLink(link, value)" />
              <span class="min-w-0 [overflow-wrap:anywhere]">{{ link.title || t('knowledgeTags.detail.untitled') }}</span>
            </label>
          </li>
        </ul>
      </fieldset>
    </template>

    <section class="grid min-w-0 gap-2 rounded-lg border bg-card px-4 py-3" aria-live="polite" data-tag-preview>
      <h3 class="m-0 text-sm font-semibold">{{ t('knowledgeTags.governance.previewTitle') }}</h3>
      <GrowthLoading v-if="previewing" variant="inline" :label="t('knowledgeTags.governance.previewing')" />
      <p v-else-if="previewError" role="alert" class="m-0 text-sm text-destructive">
        {{ t('knowledgeTags.governance.previewFailed', { error: previewError }) }}
      </p>
      <p v-else-if="preview?.blocked" role="alert" class="m-0 text-sm text-destructive" data-tag-preview-blocked>
        {{ t('knowledgeTags.governance.blocked', { message: preview.blocked.message }) }}
      </p>
      <ul v-else-if="lines.length" class="m-0 grid list-disc gap-1 pl-5 text-sm">
        <li v-for="line in lines" :key="line" class="[overflow-wrap:anywhere]">{{ line }}</li>
      </ul>
      <p v-else class="m-0 text-sm text-muted-foreground">—</p>
    </section>

    <Field>
      <FieldLabel for="tag-governance-reason">{{ t('knowledgeTags.governance.reason') }}</FieldLabel>
      <Input id="tag-governance-reason" v-model="reason" maxlength="500" autocomplete="off" :disabled="applying" />
      <FieldDescription>{{ t('knowledgeTags.governance.reasonHint') }}</FieldDescription>
    </Field>

    <p v-if="notice" :role="notice.kind" class="m-0 text-sm" :class="notice.kind === 'alert' ? 'text-destructive' : ''"
      data-tag-governance-notice>{{ notice.text }}</p>

    <!-- Stays in view while a long split form scrolls inside the dialog. -->
    <DialogFooter class="sticky -bottom-6 z-10 -mx-6 -mb-6 flex-wrap gap-2 border-t bg-card px-6 py-4" data-tag-governance-footer>
      <Button type="button" variant="ghost" :disabled="applying" data-tag-governance-back @click="emit('back')">
        {{ t('knowledgeTags.actions.back') }}
      </Button>
      <Button type="submit" :variant="change === 'retire' ? 'destructive' : 'default'" :disabled="!ready"
        :loading="applying" :loading-label="t(`knowledgeTags.governance.applying.${change}`, names)" data-tag-governance-confirm>
        {{ t(`knowledgeTags.governance.confirm.${change}`) }}
      </Button>
    </DialogFooter>
  </form>
</template>
