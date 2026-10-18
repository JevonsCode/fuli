<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { getJson, postJson, putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import UiSelect from '@/ui/UiSelect.vue'
import { currentLocale, t } from '@/i18n'

const props = defineProps<{ personalSpaceId: string; agentId: string; projects: Array<{ id: string; name: string }> }>()
interface Policy { compact_after_kb: number; context_budget: number; enabled: boolean }
interface Conversation { id: string; summary: string; status: string; revision: number; last_activity: string; compacted_through: number; raw_retained: boolean; continuation_prompt?: string }
interface Message { role: string; content: unknown; kind: string; sequence: number }
interface DigestEntry { kind: string; text: string; sources: Array<{ role: string; sequence: number }>; truncated?: boolean }
interface Digest { notes?: string[]; entries?: DigestEntry[]; omitted?: number }
interface MessagePage { events: Message[]; next_cursor?: number; has_more?: boolean; digest?: Digest | null }
interface WorkingMemory { summary: string; decisions: string[]; openThreads: string[]; nextActions: string[] }
interface MemoryView { revision: number; current: { revision: number; createdAt: string; sourceApplication: string; memory: WorkingMemory } | null }
interface CopyFeedback { conversationId: string; state: 'copied' | 'fallback' }
interface MemoryExport { filename: string; markdown: string }
const projectId = ref('')
// Global stays selected only when a person picked it; otherwise the first project wins once projects load.
const globalChosen = ref(false)
function chooseScope(value: string) { globalChosen.value = value === ''; projectId.value = value }
const settingsOpen = ref(false)
const conversations = ref<Conversation[]>([])
const loading = ref(false)
const error = ref('')
const selectedId = ref('')
const messages = ref<Message[]>([])
const digest = ref<Digest | null>(null)
const messagesLoading = ref(false)
const messagesError = ref('')
const nextCursor = ref<number>()
const hasMore = ref(false)
const memory = ref<MemoryView>()
const memoryLoading = ref(false)
const memoryError = ref('')
const policyReady = ref(false)
const policyLoading = ref(false)
const policyError = ref('')
const saving = ref(false)
const saved = ref(false)
const compactAfterKb = ref(64)
const contextBudget = ref(4000)
const enabled = ref(true)
const copyFeedback = ref<CopyFeedback>()
const exporting = ref(false)
const exportFeedback = ref<'done' | 'failed'>()
let version = 0
let messageVersion = 0
let policyVersion = 0
let copyVersion = 0
let memoryVersion = 0
let exportVersion = 0
function scope() { return { personalSpaceId: props.personalSpaceId, personalProjectId: projectId.value || null, agentId: props.agentId } }
function failure(cause: unknown) { return cause instanceof Error ? cause.message : t('projectAgents.conversations.loadFailed') }
// Declared first so the initial scope choice below also loads.
watch(projectId, () => void load())
// A string key: parent re-renders that hand over an equal project list must not reload.
watch(() => [props.agentId, props.personalSpaceId, ...props.projects.map(project => project.id)].join('\n'), () => {
  const next = (globalChosen.value && projectId.value === '') ? '' : props.projects.some(project => project.id === projectId.value) ? projectId.value : props.projects[0]?.id ?? ''
  if (next !== projectId.value) projectId.value = next
  else void load()
}, { immediate: true })
async function load() {
  const current = ++version
  ++messageVersion
  ++policyVersion
  ++copyVersion
  ++memoryVersion
  conversations.value = []; messages.value = []; digest.value = null; selectedId.value = ''; error.value = ''; messagesError.value = ''
  memory.value = undefined; memoryError.value = ''; memoryLoading.value = false
  resetExport()
  copyFeedback.value = undefined
  policyReady.value = false; policyLoading.value = false; policyError.value = ''; saved.value = false; saving.value = false
  loading.value = false; messagesLoading.value = false; hasMore.value = false
  loading.value = true
  if (settingsOpen.value) void loadPolicy()
  void loadMemory()
  try {
    const value = await postJson<{ conversations: Conversation[] }>('/api/agent-conversations/query', { ...scope(), mode: 'list', limit: 20 })
    if (current === version) conversations.value = value.conversations
  } catch (cause) { if (current === version) error.value = failure(cause) }
  finally { if (current === version) loading.value = false }
}
// Reviewed working memory for exactly the selected scope, through the existing inspection API.
async function loadMemory() {
  const current = ++memoryVersion
  memoryLoading.value = true; memoryError.value = ''; memory.value = undefined
  try {
    const query = new URLSearchParams({ personalSpaceId: props.personalSpaceId })
    if (projectId.value) query.set('personalProjectId', projectId.value)
    const value = await getJson<MemoryView>(`/api/project-agents/${encodeURIComponent(props.agentId)}/memory?${query}`)
    if (current === memoryVersion) memory.value = { revision: value?.revision ?? 0, current: value?.current ?? null }
  } catch (cause) { if (current === memoryVersion) memoryError.value = cause instanceof Error ? cause.message : t('projectAgents.conversations.memoryFailed') }
  finally { if (current === memoryVersion) memoryLoading.value = false }
}
function resetExport() { ++exportVersion; exporting.value = false; exportFeedback.value = undefined }
// A pending export answered after the view is gone must never start a download.
onBeforeUnmount(() => { ++exportVersion })
// Download a fresh database export of exactly the selected scope. A response for
// a scope, Agent or panel that is no longer shown is dropped, never saved.
async function exportMemory() {
  if (exporting.value) return
  const current = ++exportVersion
  exporting.value = true; exportFeedback.value = undefined
  try {
    const query = new URLSearchParams({ personalSpaceId: props.personalSpaceId })
    if (projectId.value) query.set('personalProjectId', projectId.value)
    const value = await getJson<MemoryExport>(`/api/project-agents/${encodeURIComponent(props.agentId)}/memory/export?${query}`)
    if (current !== exportVersion) return
    if (typeof value?.markdown !== 'string' || typeof value.filename !== 'string') throw new Error('Invalid export')
    const url = URL.createObjectURL(new Blob([value.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url; link.download = value.filename
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    exportFeedback.value = 'done'
  } catch { if (current === exportVersion) exportFeedback.value = 'failed' }
  finally { if (current === exportVersion) exporting.value = false }
}
async function readMessages(id: string, more = false) {
  if (messagesLoading.value) return
  const current = ++messageVersion
  selectedId.value = id; messagesError.value = ''; messagesLoading.value = true
  if (!more) { messages.value = []; digest.value = null; nextCursor.value = undefined; hasMore.value = false }
  try {
    const page = await postJson<MessagePage>('/api/agent-conversations/query', {
      ...scope(), mode: 'events', conversationId: id, limit: 20,
      ...(more && nextCursor.value !== undefined ? { after: nextCursor.value } : {}),
    })
    if (current !== messageVersion) return
    messages.value = more ? [...messages.value, ...page.events] : page.events
    if (!more) digest.value = page.digest ?? null
    nextCursor.value = page.next_cursor
    hasMore.value = page.has_more === true && page.next_cursor !== undefined
  } catch (cause) { if (current === messageVersion) messagesError.value = failure(cause) }
  finally { if (current === messageVersion) messagesLoading.value = false }
}
function settingsToggle(event: Event) {
  settingsOpen.value = (event.target as HTMLDetailsElement).open
  if (settingsOpen.value && !policyReady.value && !policyLoading.value) void loadPolicy()
}
function applyPolicy(value: Policy) { compactAfterKb.value = value.compact_after_kb; contextBudget.value = value.context_budget; enabled.value = value.enabled }
async function loadPolicy() {
  const current = ++policyVersion
  policyLoading.value = true; policyError.value = ''; saved.value = false
  try {
    const value = await postJson<Policy>('/api/agent-conversations/query', { ...scope(), mode: 'policy' })
    if (current === policyVersion) { applyPolicy(value); policyReady.value = true }
  } catch (cause) { if (current === policyVersion) policyError.value = failure(cause) }
  finally { if (current === policyVersion) policyLoading.value = false }
}
async function savePolicy() {
  if (saving.value || !policyReady.value) return
  saved.value = false; policyError.value = ''
  if (!Number.isInteger(compactAfterKb.value) || compactAfterKb.value < 8 || compactAfterKb.value > 1024
    || !Number.isInteger(contextBudget.value) || contextBudget.value < 512 || contextBudget.value > 16000) {
    policyError.value = t('projectAgents.conversations.invalidPolicy'); return
  }
  const current = policyVersion
  saving.value = true
  try {
    const value = await putJson<Policy>('/api/agent-conversations/policy', { ...scope(), compactAfterKb: compactAfterKb.value, contextBudget: contextBudget.value, enabled: enabled.value })
    if (current === policyVersion) { applyPolicy(value); saved.value = true }
  } catch (cause) { if (current === policyVersion) policyError.value = failure(cause) }
  finally { if (current === policyVersion) saving.value = false }
}
function date(value: string) {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? t('projectAgents.notReported') : new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(parsed)
}
function role(value: string) {
  return ['user', 'assistant', 'tool'].includes(value) ? t(`projectAgents.conversations.${value}`) : value
}
function content(value: unknown) { return typeof value === 'string' ? value : JSON.stringify(value, null, 2) }
function entryKind(value: string) {
  return t(`projectAgents.conversations.kinds.${['request', 'decision', 'correction', 'open', 'method'].includes(value) ? value : 'request'}`)
}
function client(value: string) {
  return t(`projectAgents.clients.${['codex', 'claude', 'claude_code', 'cursor', 'gemini_cli', 'kiro'].includes(value) ? value : 'other'}`)
}
async function copyContinuation(conversation: Conversation) {
  const prompt = conversation.continuation_prompt
  if (!prompt) return
  const current = ++copyVersion
  const currentProjectId = projectId.value
  copyFeedback.value = undefined
  try {
    const clipboard = globalThis.navigator?.clipboard
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable')
    await clipboard.writeText(prompt)
    if (current === copyVersion && currentProjectId === projectId.value) copyFeedback.value = { conversationId: conversation.id, state: 'copied' }
  } catch {
    if (current === copyVersion && currentProjectId === projectId.value) copyFeedback.value = { conversationId: conversation.id, state: 'fallback' }
  }
}
function selectContinuation(event: Event) { (event.target as HTMLTextAreaElement).select() }
</script>

<template>
  <section class="agent-conversations" :aria-label="t('projectAgents.conversations.title')">
    <!-- Always shown: an empty state is information, not something to hide behind a toggle. -->
    <h2 class="agent-conversations-title">{{ t('projectAgents.conversations.title') }}</h2>
      <UiSelect :model-value="projectId" field @update:model-value="chooseScope" :label="t('projectAgents.conversations.scope')" :options="[{ value: '', label: t('projectAgents.conversations.global') }, ...projects.map(project => ({ value: project.id, label: project.name }))]" />
      <p class="conversation-hint">{{ t('projectAgents.conversations.hint') }}</p>
      <section data-working-memory class="working-memory" :aria-label="t('projectAgents.conversations.memoryTitle')">
        <div class="memory-heading">
          <h3>{{ t('projectAgents.conversations.memoryTitle') }}</h3>
          <button data-export-memory class="ui-button memory-export" type="button" :disabled="exporting" :aria-busy="exporting"
            :title="t('projectAgents.conversations.exportMemory')" :aria-label="t('projectAgents.conversations.exportMemory')" @click="exportMemory">
            <GrowthLoading v-if="exporting" variant="inline" :label="t('projectAgents.conversations.exportingMemory')" />
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></svg>
          </button>
        </div>
        <p v-if="exportFeedback === 'done'" data-export-feedback role="status" class="conversation-hint">{{ t('projectAgents.conversations.exportedMemory') }}</p>
        <p v-else-if="exportFeedback === 'failed'" data-export-feedback role="alert" class="conversation-hint">{{ t('projectAgents.conversations.exportMemoryFailed') }}</p>
        <GrowthLoading v-if="memoryLoading" variant="compact" :label="t('projectAgents.conversations.loadingMemory')" />
        <div v-else-if="memoryError" role="alert"><p>{{ memoryError }}</p><button data-retry-memory class="quiet-button" type="button" @click="loadMemory">{{ t('projectAgents.retry') }}</button></div>
        <template v-else-if="memory?.current">
          <p class="conversation-hint">{{ t('projectAgents.conversations.memoryMeta', { revision: memory.current.revision, source: client(memory.current.sourceApplication), time: date(memory.current.createdAt) }) }}</p>
          <p class="memory-summary">{{ memory.current.memory.summary }}</p>
          <template v-for="group in (['decisions', 'openThreads', 'nextActions'] as const)" :key="group">
            <template v-if="memory.current.memory[group].length">
              <h4>{{ t(`projectAgents.conversations.memory.${group}`) }}</h4>
              <ul><li v-for="(note, index) in memory.current.memory[group]" :key="index">{{ note }}</li></ul>
            </template>
          </template>
          <p class="conversation-hint">{{ t('projectAgents.conversations.memoryAuthority') }}</p>
        </template>
        <p v-else-if="memory" class="conversation-hint">{{ t('projectAgents.conversations.memoryEmpty') }}</p>
      </section>
      <GrowthLoading v-if="loading" variant="compact" :label="t('projectAgents.conversations.loading')" />
      <div v-else-if="error" role="alert"><p>{{ error }}</p><button data-retry-list class="quiet-button" type="button" @click="load">{{ t('projectAgents.retry') }}</button></div>
      <ol v-else-if="conversations.length" class="conversation-list">
        <li v-for="conversation in conversations" :key="conversation.id">
          <button data-read-conversation class="conversation-link" type="button" :aria-pressed="selectedId === conversation.id" :disabled="messagesLoading" @click="readMessages(conversation.id)">
            <strong>{{ conversation.summary || t('projectAgents.conversations.untitled') }}</strong>
            <span>{{ conversation.compacted_through > 0 ? t('projectAgents.conversations.compacted') : t('projectAgents.conversations.recent') }} · <time :datetime="conversation.last_activity">{{ date(conversation.last_activity) }}</time></span>
          </button>
          <button v-if="conversation.continuation_prompt" :data-copy-continuation="conversation.id" class="quiet-button continuation-copy" type="button" @click="copyContinuation(conversation)">{{ t('projectAgents.conversations.copyContinuation') }}</button>
          <div v-if="copyFeedback?.conversationId === conversation.id" data-continuation-feedback>
            <p v-if="copyFeedback.state === 'copied'" role="status" class="conversation-hint">{{ t('projectAgents.conversations.copiedContinuation') }}</p>
            <template v-else>
              <p role="alert" class="conversation-hint">{{ t('projectAgents.conversations.copyContinuationFailed') }}</p>
              <textarea data-continuation-fallback readonly rows="3" :aria-label="t('projectAgents.conversations.manualContinuation')" :value="conversation.continuation_prompt" @focus="selectContinuation" />
            </template>
          </div>
          <div v-if="selectedId === conversation.id" class="conversation-messages">
            <p v-if="conversation.raw_retained" class="conversation-hint">{{ t('projectAgents.conversations.rawRetained') }}</p>
            <section v-if="digest && (digest.entries?.length || digest.notes?.length || digest.omitted)" data-conversation-digest class="conversation-digest">
              <h4>{{ t('projectAgents.conversations.digestTitle') }}</h4>
              <p class="conversation-hint">{{ t('projectAgents.conversations.digestHint') }}</p>
              <ul>
                <li v-for="(note, index) in digest.notes ?? []" :key="`note:${index}`"><span class="digest-kind">{{ entryKind('request') }}</span>{{ note }}</li>
                <li v-for="(entry, index) in digest.entries ?? []" :key="`entry:${index}:${entry.sources[0]?.sequence}`">
                  <span class="digest-kind">{{ entryKind(entry.kind) }}</span>{{ entry.text }}
                  <span class="digest-source">{{ entry.sources.map(source => `${role(source.role)} #${source.sequence}`).join(' · ') }}<template v-if="entry.truncated"> · {{ t('projectAgents.conversations.truncated') }}</template></span>
                </li>
              </ul>
              <p v-if="digest.omitted" class="conversation-hint">{{ t('projectAgents.conversations.omitted', { count: digest.omitted }) }}</p>
            </section>
            <ol><li v-for="message in messages" :key="message.sequence"><strong>{{ role(message.role) }} #{{ message.sequence }}</strong><pre>{{ content(message.content) }}</pre></li></ol>
            <GrowthLoading v-if="messagesLoading" variant="compact" :label="t('projectAgents.conversations.loadingMessages')" />
            <div v-else-if="messagesError" role="alert"><p>{{ messagesError }}</p><button class="quiet-button" type="button" @click="readMessages(conversation.id, messages.length > 0)">{{ t('projectAgents.retry') }}</button></div>
            <button v-else-if="hasMore" data-more-messages class="quiet-button" type="button" @click="readMessages(conversation.id, true)">{{ t('projectAgents.conversations.more') }}</button>
            <p v-else-if="!messages.length" class="conversation-hint">{{ t('projectAgents.conversations.noMessages') }}</p>
          </div>
        </li>
      </ol>
      <p v-else>{{ t('projectAgents.conversations.empty') }}</p>
      <details data-memory-settings @toggle.stop="settingsToggle">
        <summary>{{ t('projectAgents.conversations.settings') }}</summary>
        <GrowthLoading v-if="policyLoading" variant="compact" :label="t('projectAgents.conversations.loadingPolicy')" />
        <form v-if="policyReady" @submit.prevent="savePolicy">
          <fieldset :disabled="saving">
            <label class="capture-toggle"><input v-model="enabled" type="checkbox" />{{ t('projectAgents.conversations.capture') }}</label>
            <label>{{ t('projectAgents.conversations.compactAfterKb') }}<input v-model.number="compactAfterKb" name="compactAfterKb" type="number" min="8" max="1024" required /></label>
            <label>{{ t('projectAgents.conversations.budget') }}<input v-model.number="contextBudget" name="contextBudget" type="number" min="512" max="16000" required /></label>
            <p class="conversation-hint">{{ t('projectAgents.conversations.budgetHint') }}</p>
            <button class="quiet-button" type="submit"><GrowthLoading v-if="saving" variant="inline" :label="t('projectAgents.conversations.saving')" /><span v-else>{{ t('projectAgents.conversations.save') }}</span></button>
          </fieldset>
        </form>
        <div v-if="policyError" role="alert"><p>{{ policyError }}</p><button v-if="!policyReady" class="quiet-button" type="button" @click="loadPolicy">{{ t('projectAgents.retry') }}</button></div>
        <p v-if="saved" role="status">{{ t('projectAgents.conversations.saved') }}</p>
      </details>
  </section>
</template>

<style scoped>
.agent-conversations { margin-block: 20px; color: var(--color-ink); font-size: 14px; }
.agent-conversations-title { margin: 0; padding-block: 12px; font-size: 15px; font-weight: 650; }
summary { cursor: pointer; padding-block: 12px; font-weight: 650; }
summary:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 3px; }
label { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
select, input[type=number] { max-width: 100%; border: 1px solid var(--color-border-strong); border-radius: 6px; padding: 8px; font: inherit; color: inherit; background: var(--color-surface); }
input[type=number] { width: 100px; }
input[type=checkbox] { width: 18px; height: 18px; }
fieldset { display: grid; gap: 16px; border: 0; padding: 8px 0; margin: 0; min-width: 0; }
fieldset button { justify-self: start; }
.conversation-hint { color: var(--color-muted); line-height: 1.65; margin-block: 12px; }
ol { padding: 0; list-style: none; margin: 0; }
.conversation-list > li { border-bottom: 1px solid var(--color-border); }
.continuation-copy { margin-bottom: 12px; }
.conversation-link { display: grid; gap: 6px; width: 100%; text-align: left; border: 0; padding: 14px 0; font: inherit; color: inherit; background: transparent; cursor: pointer; }
.conversation-link:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.conversation-link[aria-pressed=true] strong { color: var(--color-ink); }
.conversation-link span { color: var(--color-muted); font-size: 12px; }
.conversation-link strong { overflow-wrap: anywhere; }
.conversation-messages { padding-bottom: 16px; }
.conversation-messages li { padding-block: 12px; }
.working-memory, .conversation-digest { margin-block: 16px; }
.working-memory h3, .conversation-digest h4, .working-memory h4 { font-size: inherit; margin-block: 8px; }
.memory-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; }
.memory-export { width: 32px; height: 32px; flex: 0 0 32px; padding: 6px; }
.memory-export svg { width: 18px; height: 18px; }
.working-memory ul, .conversation-digest ul { margin: 0; padding-left: 18px; line-height: 1.65; overflow-wrap: anywhere; }
.conversation-digest li { padding-block: 4px; }
.memory-summary { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.digest-kind { font-weight: 650; margin-right: 8px; }
.digest-source { display: block; color: var(--color-muted); font-size: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; max-height: 320px; overflow: auto; margin-block: 8px; }
textarea { width: 100%; box-sizing: border-box; border: 1px solid #a8b7ad; border-radius: 6px; padding: 8px; font: inherit; color: inherit; background: #fff; resize: vertical; }
button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 640px) { .agent-conversations { font-size: 16px; } }
</style>
