<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { getJson } from '@/api/client'
import { OptionCombobox } from '@/components/ui/combobox'
import { t } from '@/i18n'
import { createDebouncedAction } from '@/lib/debounce'
import UiNotice from '@/ui/UiNotice.vue'
import { peerApiMessage, shareableSearchShape, shareableShape, type Shareable, type ShareableSearch } from './peer-model'

// 「添加项目」: finds any other project of this computer by name, as the person
// types, and hands the picked one's full entry to the card as a new row.
// Nothing is shared here; the card saves only what is ticked.
const props = defineProps<{ listed: readonly string[]; disabled?: boolean }>()
const emit = defineEmits<{ pick: [project: Shareable] }>()

const SEARCH_DELAY_MS = 250
const SEARCH_LIMIT = 20

const query = ref('')
const found = ref<ShareableSearch>({ projects: [], more: false })
const reading = ref<'search' | 'project' | ''>('')
const error = ref('')
const chosen = ref('')
let asked = 0

// Projects the card already shows (added in this visit) are not offered twice.
const options = computed(() => found.value.projects.filter((project) => !props.listed.includes(project.projectId))
  .map((project) => ({ value: project.projectId, label: project.projectName })))

async function search() {
  const ticket = ++asked
  const text = query.value.trim()
  reading.value = 'search'
  error.value = ''
  try {
    const params = new URLSearchParams({ query: text, limit: String(SEARCH_LIMIT) })
    const next = await getJson(`/api/peer/shareable?${params}`, shareableSearchShape)
    if (ticket === asked) found.value = next
  } catch (caught) {
    if (ticket === asked) error.value = peerApiMessage(caught, t('settings.peer.searchError'))
  } finally {
    if (ticket === asked && reading.value === 'search') reading.value = ''
  }
}

const debounced = createDebouncedAction(() => { void search() }, SEARCH_DELAY_MS)
onMounted(search)
onUnmounted(() => debounced.cancel())

function typed(text: string) {
  query.value = text
  debounced.schedule()
}

async function pick(projectId: string) {
  if (!projectId) return
  chosen.value = projectId
  reading.value = 'project'
  error.value = ''
  try {
    emit('pick', await getJson(`/api/peer/shareable/${encodeURIComponent(projectId)}`, shareableShape))
  } catch (caught) {
    error.value = peerApiMessage(caught, t('settings.peer.searchError'))
  } finally {
    chosen.value = ''
    reading.value = ''
  }
}
</script>

<template>
  <div class="peer-share-picker" data-peer-share-picker>
    <OptionCombobox :model-value="chosen" :options="options" :label="t('settings.peer.addProject')"
      :placeholder="t('settings.peer.addProjectPlaceholder')" size="sm" search-on-server
      :loading="Boolean(reading)" :loading-label="t(reading === 'project' ? 'settings.peer.readingProject' : 'settings.peer.searchingProjects')"
      :empty-label="t('settings.peer.noProjectFound')" :hint="found.more ? t('settings.peer.moreProjects') : undefined"
      :disabled="disabled || reading === 'project'" control-id="peer-add-project"
      @search="typed" @update:model-value="pick" />
    <UiNotice v-if="error" tone="error" data-share-search-error>{{ error }}</UiNotice>
  </div>
</template>

<style scoped>
.peer-share-picker { display: grid; gap: 8px; max-width: 360px; min-width: 0; }
</style>
