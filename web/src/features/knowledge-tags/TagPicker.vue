<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import { apiErrorReason } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'
import { isLive, statusLabel, type TagEntry, type TagRef } from './model'
import { readVocabulary } from './tags-api'

// Choose another live tag: a merge target or a relation's other end. The
// Provider still decides whether the pair is allowed; `allows` only hides
// what can never be chosen (the tag itself, another project's vocabulary).
const SEARCH_DELAY_MS = 250
const props = defineProps<{ spaceId: string; label: string; allows: (tag: TagEntry) => boolean }>()
const chosen = defineModel<TagRef | null>({ required: true })

const query = ref('')
const found = ref<TagEntry[]>([])
const searching = ref(false)
const error = ref('')
let request = 0
const choices = computed(() => found.value.filter(tag => isLive(tag) && props.allows(tag)))

async function search() {
  const current = ++request
  searching.value = true
  error.value = ''
  try {
    const read = await readVocabulary(props.spaceId, { query: query.value })
    if (current === request) found.value = read.tags
  } catch (cause) {
    if (current === request) error.value = apiErrorReason(cause)
  } finally {
    if (current === request) searching.value = false
  }
}

const debounced = createDebouncedAction(() => void search(), SEARCH_DELAY_MS)
watch(query, () => debounced.schedule())
onBeforeUnmount(() => debounced.cancel())
void search()
</script>

<template>
  <div class="grid min-w-0 gap-2" data-tag-picker>
    <Input v-model="query" type="search" :aria-label="label" :placeholder="t('knowledgeTags.governance.pickPlaceholder')"
      autocomplete="off" />
    <GrowthLoading v-if="searching" variant="inline" :label="t('knowledgeTags.governance.picking')" />
    <p v-else-if="error" role="alert" class="m-0 text-sm text-destructive">{{ error }}</p>
    <p v-else-if="!choices.length" class="m-0 text-sm text-muted-foreground">{{ t('knowledgeTags.governance.noCandidates') }}</p>
    <ul v-if="choices.length" class="m-0 grid max-h-56 list-none gap-2 overflow-y-auto p-0" role="listbox" :aria-label="label">
      <li v-for="tag in choices" :key="tag.id" class="min-w-0">
        <!-- The chosen tag lifts as a card; there is no side accent. -->
        <Button type="button" variant="outline" role="option" :aria-selected="chosen?.id === tag.id"
          class="h-auto w-full min-w-0 justify-between gap-2 rounded-lg bg-card px-3 py-2 text-left font-normal whitespace-normal transition-[border-color,box-shadow]"
          :class="chosen?.id === tag.id ? 'border-border-strong shadow-md' : 'hover:border-border-strong'"
          :data-tag-choice="tag.id" @click="chosen = tag">
          <span class="min-w-0 [overflow-wrap:anywhere]">{{ tag.name }}</span>
          <Badge variant="secondary" class="shrink-0">{{ statusLabel(tag.status) }}</Badge>
        </Button>
      </li>
    </ul>
  </div>
</template>
