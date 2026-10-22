<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { previewLines, type GovernancePreview } from '@/features/knowledge-tags/model'
import { t } from '@/i18n'
import UiIconButton from '@/ui/UiIconButton.vue'
import { editFailure, type EditFailure, type ItemTag, type KnowledgeItemSummary } from './model'
import { changeTag, createTag, findTags, type TagCandidate } from './quick-edit-api'

// The item's tags: the ones actually attached, removable, and the visible
// vocabulary to reuse before a new tag is made. Tags never change content or
// confirmation; removing one keeps its history.
const props = defineProps<{ item: KnowledgeItemSummary; spaceId: string }>()
const emit = defineEmits<{ changed: []; failed: [reason: EditFailure] }>()

const query = ref('')
const candidates = ref<TagCandidate[]>([])
const pending = ref<'attach' | 'detach' | null>(null)
const error = ref('')
// A retired tag's word: bringing it back would drop something, so the person confirms its preview first.
const revival = ref<GovernancePreview | null>(null)
const attached = computed(() => new Set(props.item.tags.map(tag => tag.id)))
const choices = computed(() => candidates.value.filter(tag => !attached.value.has(tag.id)))
const exact = computed(() => candidates.value.some(tag => tag.match === 'exact'))
let searchVersion = 0
watch(query, () => { void search() })

async function search() {
  const current = ++searchVersion
  const text = query.value.trim()
  if (!text) { candidates.value = []; return }
  try {
    const result = await findTags(props.spaceId, props.item, text)
    if (current === searchVersion) candidates.value = result.candidates ?? []
  } catch (cause) {
    if (current === searchVersion) error.value = (cause as Error).message
  }
}

async function run(action: 'attach' | 'detach', operation: () => Promise<unknown>) {
  pending.value = action
  error.value = ''
  revival.value = null
  try {
    await operation()
    query.value = ''
    candidates.value = []
    emit('changed')
  } catch (cause) {
    const failure = editFailure(cause)
    error.value = failure === 'forbidden' ? t('knowledgeQuickEdit.forbidden') : (cause as Error).message
    emit('failed', failure)
  } finally {
    pending.value = null
  }
}

const attach = (tag: Pick<ItemTag, 'id'>) => run('attach', () => changeTag(props.spaceId, props.item, 'attach', tag))
const detach = (tag: ItemTag) => run('detach', () => changeTag(props.spaceId, props.item, 'detach', tag))

function create() {
  const name = query.value.trim()
  return run('attach', async () => {
    const created = await createTag(props.spaceId, props.item, name, t('knowledgeQuickEdit.tags.add'))
    if (created.outcome === 'needs_person' && created.revival) {
      revival.value = created.revival
      return
    }
    if (created.outcome === 'needs_decision' || !created.tag) {
      candidates.value = created.candidates ?? []
      throw new Error(t('knowledgeQuickEdit.tags.similar', { names: candidates.value.map(tag => tag.name).join('、') }))
    }
    await changeTag(props.spaceId, props.item, 'attach', created.tag)
  })
}
</script>

<template>
  <Card as="section" data-tag-editor>
    <CardHeader><CardTitle as="h2">{{ t('knowledgeQuickEdit.tags.title') }}</CardTitle></CardHeader>
    <div class="grid gap-3 px-5">
      <ul class="m-0 flex list-none flex-wrap gap-1.5 p-0" data-attached-tags>
        <li v-for="tag in item.tags" :key="tag.id">
          <Badge variant="outline" class="gap-0.5 pr-0.5" :title="tag.name">
            #{{ tag.name }}
            <UiIconButton icon="close" size="sm" :label="t('knowledgeQuickEdit.tags.remove', { name: tag.name })"
              :disabled="pending !== null" @click="detach(tag)" />
          </Badge>
        </li>
        <li v-if="!item.tags.length" class="text-sm text-muted-foreground">{{ t('knowledgeQuickEdit.tags.none') }}</li>
      </ul>
      <Field>
        <FieldLabel for="tag-search">{{ t('knowledgeQuickEdit.tags.add') }}</FieldLabel>
        <Input id="tag-search" v-model="query" :placeholder="t('knowledgeQuickEdit.tags.search')" maxlength="80"
          autocomplete="off" :disabled="pending !== null" />
      </Field>
      <div v-if="query.trim()" class="flex flex-wrap gap-1.5" data-tag-choices>
        <Button v-for="tag in choices" :key="tag.id" size="sm" variant="outline" :disabled="pending !== null"
          :data-tag-choice="tag.id" @click="attach(tag)">#{{ tag.name }}</Button>
        <Button v-if="!exact" size="sm" variant="ghost" :disabled="pending !== null" data-tag-create @click="create">
          {{ t('knowledgeQuickEdit.tags.create', { name: query.trim() }) }}
        </Button>
      </div>
      <GrowthLoading v-if="pending" variant="inline"
        :label="t(pending === 'attach' ? 'knowledgeQuickEdit.tags.attaching' : 'knowledgeQuickEdit.tags.detaching')" />
      <div v-if="revival" role="status" class="grid gap-2 rounded-lg border border-warning bg-card px-4 py-3 text-sm"
        data-tag-revival>
        <p class="m-0">{{ t('knowledgeQuickEdit.tags.revival') }}</p>
        <ul class="m-0 grid list-disc gap-1 pl-5">
          <li v-for="line in previewLines(revival)" :key="line" class="[overflow-wrap:anywhere]">{{ line }}</li>
        </ul>
        <RouterLink :to="{ path: '/tags', query: { tag: revival.tag.id, change: 'revive' } }"
          class="justify-self-start underline underline-offset-4" data-tag-revival-confirm>
          {{ t('knowledgeQuickEdit.tags.revivalConfirm', { name: revival.tag.name }) }}
        </RouterLink>
      </div>
      <p v-if="error" role="alert" class="m-0 text-sm text-destructive">{{ error }}</p>
    </div>
  </Card>
</template>
