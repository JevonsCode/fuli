<script setup lang="ts">
import { ref, watch } from 'vue'
import { postJson, putJson } from '@/api/client'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'

const props = defineProps<{ personalSpaceId: string; agentId: string; projects: Array<{ id: string; name: string }> }>()
interface Policy { idle_days: number; context_budget: number; enabled: boolean }
interface Conversation { id: string; summary: string; status: string; revision: number; last_activity: string; archived: boolean; raw_retained: boolean }
interface Message { role: string; content: unknown; kind: string; sequence: number }
interface MessagePage { events: Message[]; next_cursor?: number; has_more?: boolean }
const projectId = ref('')
const opened = ref(false)
const settingsOpen = ref(false)
const conversations = ref<Conversation[]>([])
const loading = ref(false)
const error = ref('')
const selectedId = ref('')
const messages = ref<Message[]>([])
const messagesLoading = ref(false)
const messagesError = ref('')
const nextCursor = ref<number>()
const hasMore = ref(false)
const policyReady = ref(false)
const policyLoading = ref(false)
const policyError = ref('')
const saving = ref(false)
const saved = ref(false)
const idleDays = ref(7)
const contextBudget = ref(2000)
const enabled = ref(true)
let version = 0
let messageVersion = 0
let policyVersion = 0
function scope() { return { personalSpaceId: props.personalSpaceId, personalProjectId: projectId.value, agentId: props.agentId } }
function failure(cause: unknown) { return cause instanceof Error ? cause.message : t('projectAgents.conversations.loadFailed') }
watch(() => [props.agentId, props.personalSpaceId, props.projects.map(project => project.id).join('\n')], () => {
  const next = props.projects.some(project => project.id === projectId.value) ? projectId.value : props.projects[0]?.id ?? ''
  if (next !== projectId.value) projectId.value = next
  else void load()
}, { immediate: true })
watch(projectId, () => void load())
async function load() {
  const current = ++version
  ++messageVersion
  ++policyVersion
  conversations.value = []; messages.value = []; selectedId.value = ''; error.value = ''; messagesError.value = ''
  policyReady.value = false; policyLoading.value = false; policyError.value = ''; saved.value = false; saving.value = false
  loading.value = false; messagesLoading.value = false; hasMore.value = false
  if (!opened.value || !projectId.value) return
  loading.value = true
  if (settingsOpen.value) void loadPolicy()
  try {
    const value = await postJson<{ conversations: Conversation[] }>('/api/agent-conversations/query', { ...scope(), mode: 'list', limit: 20 })
    if (current === version) conversations.value = value.conversations
  } catch (cause) { if (current === version) error.value = failure(cause) }
  finally { if (current === version) loading.value = false }
}
function toggle(event: Event) {
  const next = (event.target as HTMLDetailsElement).open
  if (next === opened.value) return
  opened.value = next
  if (next) void load()
  else { ++version; ++messageVersion; ++policyVersion; settingsOpen.value = false }
}
async function readMessages(id: string, more = false) {
  if (messagesLoading.value || !projectId.value) return
  const current = ++messageVersion
  selectedId.value = id; messagesError.value = ''; messagesLoading.value = true
  if (!more) { messages.value = []; nextCursor.value = undefined; hasMore.value = false }
  try {
    const page = await postJson<MessagePage>('/api/agent-conversations/query', {
      ...scope(), mode: 'events', conversationId: id, limit: 20,
      ...(more && nextCursor.value !== undefined ? { after: nextCursor.value } : {}),
    })
    if (current !== messageVersion) return
    messages.value = more ? [...messages.value, ...page.events] : page.events
    nextCursor.value = page.next_cursor
    hasMore.value = page.has_more === true && page.next_cursor !== undefined
  } catch (cause) { if (current === messageVersion) messagesError.value = failure(cause) }
  finally { if (current === messageVersion) messagesLoading.value = false }
}
function settingsToggle(event: Event) {
  settingsOpen.value = (event.target as HTMLDetailsElement).open
  if (settingsOpen.value && !policyReady.value && !policyLoading.value && opened.value) void loadPolicy()
}
function applyPolicy(value: Policy) { idleDays.value = value.idle_days; contextBudget.value = value.context_budget; enabled.value = value.enabled }
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
  if (!Number.isInteger(idleDays.value) || idleDays.value < 1 || idleDays.value > 365
    || !Number.isInteger(contextBudget.value) || contextBudget.value < 512 || contextBudget.value > 16000) {
    policyError.value = t('projectAgents.conversations.invalidPolicy'); return
  }
  const current = policyVersion
  saving.value = true
  try {
    const value = await putJson<Policy>('/api/agent-conversations/policy', { ...scope(), idleDays: idleDays.value, contextBudget: contextBudget.value, enabled: enabled.value })
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
</script>

<template>
  <details class="agent-conversations" @toggle="toggle">
    <summary>{{ t('projectAgents.conversations.title') }}</summary>
    <template v-if="opened">
      <label v-if="projects.length">{{ t('projectAgents.fields.project') }}
        <select v-model="projectId"><option v-for="project in projects" :key="project.id" :value="project.id">{{ project.name }}</option></select>
      </label>
      <p class="conversation-hint">{{ t('projectAgents.conversations.hint') }}</p>
      <GrowthLoading v-if="loading" variant="compact" :label="t('projectAgents.conversations.loading')" />
      <div v-else-if="error" role="alert"><p>{{ error }}</p><button data-retry-list class="quiet-button" type="button" @click="load">{{ t('projectAgents.retry') }}</button></div>
      <ol v-else-if="conversations.length" class="conversation-list">
        <li v-for="conversation in conversations" :key="conversation.id">
          <button data-read-conversation class="conversation-link" type="button" :aria-pressed="selectedId === conversation.id" :disabled="messagesLoading" @click="readMessages(conversation.id)">
            <strong>{{ conversation.summary || t('projectAgents.conversations.untitled') }}</strong>
            <span>{{ conversation.archived ? t('projectAgents.conversations.archived') : t('projectAgents.conversations.recent') }} · <time :datetime="conversation.last_activity">{{ date(conversation.last_activity) }}</time></span>
          </button>
          <div v-if="selectedId === conversation.id" class="conversation-messages">
            <p v-if="conversation.raw_retained" class="conversation-hint">{{ t('projectAgents.conversations.rawRetained') }}</p>
            <ol><li v-for="message in messages" :key="message.sequence"><strong>{{ role(message.role) }}</strong><pre>{{ content(message.content) }}</pre></li></ol>
            <GrowthLoading v-if="messagesLoading" variant="compact" :label="t('projectAgents.conversations.loadingMessages')" />
            <div v-else-if="messagesError" role="alert"><p>{{ messagesError }}</p><button class="quiet-button" type="button" @click="readMessages(conversation.id, messages.length > 0)">{{ t('projectAgents.retry') }}</button></div>
            <button v-else-if="hasMore" data-more-messages class="quiet-button" type="button" @click="readMessages(conversation.id, true)">{{ t('projectAgents.conversations.more') }}</button>
            <p v-else-if="!messages.length" class="conversation-hint">{{ t('projectAgents.conversations.noMessages') }}</p>
          </div>
        </li>
      </ol>
      <p v-else>{{ t('projectAgents.conversations.empty') }}</p>
      <details v-if="projectId" data-memory-settings @toggle.stop="settingsToggle">
        <summary>{{ t('projectAgents.conversations.settings') }}</summary>
        <GrowthLoading v-if="policyLoading" variant="compact" :label="t('projectAgents.conversations.loadingPolicy')" />
        <form v-if="policyReady" @submit.prevent="savePolicy">
          <fieldset :disabled="saving">
            <label class="capture-toggle"><input v-model="enabled" type="checkbox" />{{ t('projectAgents.conversations.capture') }}</label>
            <label>{{ t('projectAgents.conversations.idleDays') }}<input v-model.number="idleDays" name="idleDays" type="number" min="1" max="365" required /></label>
            <label>{{ t('projectAgents.conversations.budget') }}<input v-model.number="contextBudget" name="contextBudget" type="number" min="512" max="16000" required /></label>
            <p class="conversation-hint">{{ t('projectAgents.conversations.budgetHint') }}</p>
            <button class="quiet-button" type="submit"><GrowthLoading v-if="saving" variant="inline" :label="t('projectAgents.conversations.saving')" /><span v-else>{{ t('projectAgents.conversations.save') }}</span></button>
          </fieldset>
        </form>
        <div v-if="policyError" role="alert"><p>{{ policyError }}</p><button v-if="!policyReady" class="quiet-button" type="button" @click="loadPolicy">{{ t('projectAgents.retry') }}</button></div>
        <p v-if="saved" role="status">{{ t('projectAgents.conversations.saved') }}</p>
      </details>
    </template>
  </details>
</template>

<style scoped>
.agent-conversations { margin-block: 20px; color: #39483f; font-size: 14px; }
summary { cursor: pointer; padding-block: 12px; font-weight: 650; }
summary:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #315c43; outline-offset: 3px; }
label { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; }
select, input[type=number] { max-width: 100%; border: 1px solid #a8b7ad; border-radius: 6px; padding: 8px; font: inherit; color: inherit; background: #fff; }
input[type=number] { width: 100px; }
input[type=checkbox] { width: 18px; height: 18px; }
fieldset { display: grid; gap: 16px; border: 0; padding: 8px 0; margin: 0; min-width: 0; }
fieldset button { justify-self: start; }
.conversation-hint { color: #58675d; line-height: 1.65; margin-block: 12px; }
ol { padding: 0; list-style: none; margin: 0; }
.conversation-list > li { border-bottom: 1px solid #dce3de; }
.conversation-link { display: grid; gap: 6px; width: 100%; text-align: left; border: 0; padding: 14px 0; font: inherit; color: inherit; background: transparent; cursor: pointer; }
.conversation-link:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.conversation-link[aria-pressed=true] strong { color: #315c43; }
.conversation-link span { color: #58675d; font-size: 12px; }
.conversation-link strong { overflow-wrap: anywhere; }
.conversation-messages { padding-bottom: 16px; }
.conversation-messages li { padding-block: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.65; max-height: 320px; overflow: auto; margin-block: 8px; }
button:disabled { cursor: wait; opacity: .65; }
@media (max-width: 640px) { .agent-conversations { font-size: 16px; } }
</style>
