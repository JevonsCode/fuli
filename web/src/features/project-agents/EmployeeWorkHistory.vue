<script setup lang="ts">
import { ref, watch } from 'vue'
import { getJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'

const props = defineProps<{
  personalSpaceId: string
  agentId: string
  projects: Array<{ id: string; name: string }>
}>()
interface WorkRecord { taskContextToken: string; sourceApplication: string; createdAt: string; status: string; summary: string }
const projectId = ref('')
const opened = ref(false)
const loading = ref(false)
const error = ref('')
const records = ref<WorkRecord[]>([])
let version = 0
watch(() => [props.agentId, props.personalSpaceId, props.projects.map(project => project.id).join('\n')], () => {
  const next = props.projects.some(project => project.id === projectId.value)
    ? projectId.value : props.projects[0]?.id ?? ''
  if (next !== projectId.value) projectId.value = next
  else void load()
}, { immediate: true })
watch(projectId, () => void load())

async function load() {
  const current = ++version
  records.value = []
  error.value = ''
  loading.value = false
  if (!opened.value || !projectId.value) return
  loading.value = true
  try {
    const query = new URLSearchParams({ personalSpaceId: props.personalSpaceId, personalProjectId: projectId.value })
    const value = await getJson<{ workLog?: WorkRecord[] }>(`/api/project-agents/${encodeURIComponent(props.agentId)}/memory?${query}`)
    if (current === version) records.value = value.workLog ?? []
  } catch (cause) {
    if (current === version) error.value = cause instanceof Error ? cause.message : t('projectAgents.workHistory.loadFailed')
  } finally {
    if (current === version) loading.value = false
  }
}
function toggle(event: Event) {
  const next = (event.target as HTMLDetailsElement).open
  if (next === opened.value) return
  opened.value = next
  if (opened.value) void load()
  else ++version
}
function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? t('projectAgents.notReported') : new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'short', timeStyle: 'short',
  }).format(parsed)
}
function status(value: string) {
  return t(`projectAgents.workHistory.${['reported', 'completed', 'incomplete', 'failed', 'no_change', 'unreported', 'running'].includes(value) ? value : 'unreported'}`)
}
</script>

<template>
  <details class="employee-work-history" @toggle="toggle">
    <summary>{{ t('projectAgents.workHistory.title') }}</summary>
    <label v-if="projects.length">{{ t('projectAgents.fields.project') }}
      <select v-model="projectId">
        <option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option>
      </select>
    </label>
    <GrowthLoading v-if="loading" variant="compact" :label="t('projectAgents.workHistory.loading')" />
    <div v-else-if="error" role="alert">
      <p>{{ error }}</p><button type="button" class="quiet-button" @click="load">{{ t('projectAgents.retry') }}</button>
    </div>
    <ol v-else-if="records.length">
      <li v-for="record in records" :key="record.taskContextToken">
        <div class="work-record-meta"><strong>{{ status(record.status) }}</strong><span>{{ record.sourceApplication }}</span><time :datetime="record.createdAt">{{ date(record.createdAt) }}</time></div>
        <p>{{ record.summary }}</p>
      </li>
    </ol>
    <p v-else>{{ t('projectAgents.workHistory.empty') }}</p>
  </details>
</template>

<style scoped>
.employee-work-history { margin-block: 24px; font-size: 14px; }
summary { cursor: pointer; font-weight: 650; padding-block: 12px; }
label { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
select { max-width: 100%; padding: 8px; font: inherit; }
ol { list-style: none; padding: 0; margin: 12px 0; }
li { border-top: 1px solid #dce3de; padding-block: 14px; }
.work-record-meta { display: flex; gap: 12px; flex-wrap: wrap; align-items: baseline; }
p { line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 640px) { .employee-work-history { font-size: 16px; } }
</style>
