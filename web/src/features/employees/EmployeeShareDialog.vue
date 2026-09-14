<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getJson, patchJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { useModalDialog } from '@/composables/useModalDialog'
import { t } from '@/i18n'
import ProjectScopePicker from './ProjectScopePicker.vue'
import { employeeErrorMessage } from './catalog'
import { publicProjectReport, reportUrl } from './shared-report'
type ShareState = { id: string; publicShareEnabled: boolean; publicShareSlug?: string }
const props = defineProps<{ open: boolean; projects: { id: string; name: string }[] }>()
const emit = defineEmits<{ close: [] }>()
const selected = ref<string[]>([])
const states = ref<Record<string, ShareState>>({})
const counts = ref<Record<string, number>>({})
const loading = ref(false)
const busy = ref(false)
const busyAction = ref<'generate' | 'revoke' | null>(null)
const busyProjectId = ref('')
const error = ref('')
const link = ref('')
const copied = ref(false)
let version = 0
const { dialogRef, initialFocusRef, onCancel, onKeydown } = useModalDialog(() => props.open, close)
const enabled = computed(() => props.projects.filter(project => states.value[project.id]?.publicShareEnabled))
const selectedCount = computed(() => selected.value.every(id => counts.value[id] !== undefined)
  ? selected.value.reduce((total, id) => total + counts.value[id]!, 0) : null)
const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
watch([() => props.open, () => JSON.stringify(props.projects.map(project => project.id))], () => { if (props.open) void load(); else ++version }, { immediate: true })
watch(selected, () => { link.value = ''; copied.value = false })
function base(id: string) { return `/employee-workspaces/jefa/${encodeURIComponent(id)}/api` }
async function load(preserveSelection = false) {
  const current = ++version
  if (!preserveSelection) selected.value = []
  states.value = {}; counts.value = {}; error.value = ''; link.value = ''; loading.value = true
  const results = await Promise.allSettled(props.projects.map(async project => {
    const result = await getJson<{ snapshot: { projects: ShareState[] } }>(`${base(project.id)}/snapshot`)
    const state = result.snapshot.projects.find(item => item.id === project.id)
    if (!state) throw new Error(t('employees.loadError'))
    let count: number | null = null
    let previewFailed = false
    if (state.publicShareEnabled && state.publicShareSlug) {
      try { count = (await publicProjectReport({ id: project.id, slug: state.publicShareSlug })).items.length }
      catch { previewFailed = true }
    }
    return { state, count, previewFailed }
  }))
  if (current !== version) return
  for (const result of results) if (result.status === 'fulfilled') {
    states.value[result.value.state.id] = result.value.state
    if (result.value.count !== null) counts.value[result.value.state.id] = result.value.count
  }
  if (results.some(result => result.status === 'rejected' || result.value.previewFailed)) error.value = t('employees.share.loadFailed')
  loading.value = false
}
async function generate() {
  if (!selected.value.length || busy.value || loading.value || selectedCount.value === 0) return
  busy.value = true; busyAction.value = 'generate'; busyProjectId.value = ''; error.value = ''; link.value = ''; copied.value = false
  const current = version
  const ids = selected.value.filter(id => props.projects.some(project => project.id === id))
  try {
    const results = await Promise.allSettled(ids.map(async id => {
      if (!states.value[id]) throw new Error(t('employees.share.loadFailed'))
      let state = states.value[id]!
      if (!state.publicShareEnabled || !state.publicShareSlug) {
        const result = await patchJson<{ project: ShareState }>(`/employee-workspaces/jefa/${encodeURIComponent(id)}/api/projects/${encodeURIComponent(id)}/sharing`, { publicShareEnabled: true, acceptsPublicRequests: false })
        state = result.project
        if (state.id !== id || !state.publicShareEnabled || !state.publicShareSlug) throw new Error(t('employees.loadError'))
        if (current !== version) throw new Error(t('employees.share.loadFailed'))
        states.value[id] = state
      }
      // Verify the actual public projection before offering a supposedly useful link.
      const count = (await publicProjectReport({ id, slug: state.publicShareSlug! })).items.length
      if (current !== version) throw new Error(t('employees.share.loadFailed'))
      counts.value[id] = count
      return { id, slug: state.publicShareSlug! }
    }))
    if (current !== version) return
    if (results.some(result => result.status === 'rejected')) throw new Error(t('employees.share.partial'))
    if (ids.every(id => counts.value[id] === 0)) throw new Error(t('employees.shareContent.emptySelection'))
    link.value = reportUrl(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []), window.location.origin)
  } catch (cause) { if (current === version) error.value = employeeErrorMessage(cause) }
  finally { busy.value = false; busyAction.value = null; busyProjectId.value = '' }
}
async function revoke(id: string) {
  if (busy.value) return
  busy.value = true; busyAction.value = 'revoke'; busyProjectId.value = id; error.value = ''; link.value = ''; copied.value = false
  try {
    const result = await patchJson<{ project: ShareState }>(`/employee-workspaces/jefa/${encodeURIComponent(id)}/api/projects/${encodeURIComponent(id)}/sharing`, { publicShareEnabled: false, acceptsPublicRequests: false })
    if (result.project.id !== id || result.project.publicShareEnabled) throw new Error(t('employees.loadError'))
    states.value[id] = result.project
    delete counts.value[id]
  } catch (cause) { error.value = employeeErrorMessage(cause) }
  finally { busy.value = false; busyAction.value = null; busyProjectId.value = '' }
}
async function copy() {
  try { await navigator.clipboard.writeText(link.value); copied.value = true }
  catch { error.value = t('employees.share.copyFailed') }
}
function close() { if (!busy.value) emit('close') }
</script>

<template>
  <dialog ref="dialogRef" class="employee-dialog employee-share-dialog" aria-labelledby="employee-share-title" @cancel="onCancel" @keydown="onKeydown">
    <div class="employee-dialog-shell">
      <header><h2 id="employee-share-title">{{ t('employees.share.title') }}</h2><button ref="initialFocusRef" type="button" :disabled="busy" :aria-label="t('employees.close')" @click="close">×</button></header>
      <div class="employee-dialog-body">
        <p>{{ t('employees.share.scopeHint') }}</p>
        <p>{{ t('employees.share.disclosure') }}</p>
        <GrowthLoading v-if="loading" variant="compact" :label="t('employees.loadingShare')" />
        <fieldset :disabled="busy || loading"><ProjectScopePicker v-model="selected" :projects="projects" :disabled="busy || loading" inline :label="t('employees.share.projects')" :hint="t('employees.share.selectionHint')" /></fieldset>
        <p v-if="selected.length && !loading" class="employee-share-preview" role="status">{{ selectedCount === null ? t('employees.shareContent.verifyContent') : t('employees.shareContent.publicCount', { count: selectedCount }) }}</p>
        <p v-if="selected.length && !loading && selectedCount === 0" class="employee-share-empty">{{ t('employees.shareContent.emptySelection') }}</p>
        <button type="button" :disabled="busy || loading" @click="load(true)">{{ t('common.actions.refresh') }}</button>
        <div v-if="error" class="employee-dialog-error" role="alert"><p>{{ error }}</p><button v-if="!busy" type="button" @click="load(true)">{{ t('employees.retry') }}</button></div>
        <div v-if="link" class="employee-share-result">
          <label>{{ t('employees.share.link') }}<input :value="link" readonly :aria-label="t('employees.share.link')" @focus="($event.target as HTMLInputElement).select()" /></label>
          <div><button type="button" @click="copy">{{ t(copied ? 'employees.share.copied' : 'employees.share.copy') }}</button><a :href="link" target="_blank" rel="noreferrer">{{ t('employees.share.preview') }}</a></div>
        </div>
        <p v-if="isLocal" class="employee-share-local">{{ t('employees.share.local') }}</p>
        <section v-if="enabled.length" class="employee-share-active"><h3>{{ t('employees.share.active') }}</h3><div v-for="project in enabled" :key="project.id"><span>{{ project.name }}</span><button type="button" :disabled="busy" @click="revoke(project.id)"><GrowthLoading v-if="busyAction === 'revoke' && busyProjectId === project.id" variant="inline" :label="t('employees.share.revoking')" /><template v-else>{{ t('employees.share.revoke') }}</template></button></div></section>
      </div>
      <footer><span>{{ t('employees.scope.count', { selected: selected.length, total: projects.length }) }}</span><button class="primary" type="button" :disabled="!selected.length || busy || loading || selectedCount === 0" @click="generate"><GrowthLoading v-if="busyAction === 'generate'" variant="inline" :label="t('employees.share.generating')" /><template v-else>{{ t('employees.share.generate') }}</template></button></footer>
    </div>
  </dialog>
</template>

<style src="./employee-dialog.css"></style>
<style scoped>
fieldset { min-width: 0; margin: 0; padding: 0; border: 0; }
.employee-share-result { display: grid; gap: 12px; }
.employee-share-result label { display: grid; gap: 8px; font-size: 13px; }
.employee-share-result > div { display: flex; gap: 16px; align-items: center; }
.employee-share-result a { color: #315c43; font-size: 13px; }
.employee-share-local { color: #725a2d; }
.employee-share-preview { font-weight: 600; color: #315c43; }
.employee-share-empty { color: #725a2d; line-height: 1.6; }
.employee-share-active { border-top: 1px solid #e6ece8; padding-top: 16px; }
.employee-share-active h3 { margin: 0 0 10px; font-size: 14px; }
.employee-share-active > div { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; font-size: 13px; }
.employee-share-active span { overflow-wrap: anywhere; }
footer > span { margin-right: auto; color: #526659; font-size: 12px; }
</style>
