<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'

import GrowthLoading from '@/components/GrowthLoading.vue'
import { currentLocale, t } from '@/i18n'
import { listThreads, readThread, type RoundtableMessage, type RoundtablePerson, type RoundtableThread, type RoundtableThreadSummary } from './roundtable-api'

// A read-only record of Agents talking to each other. Agents start these
// conversations themselves through message_agent; people only watch.
const route = useRoute()
const threads = ref<RoundtableThreadSummary[]>([])
const thread = ref<RoundtableThread | null>(null)
const loading = ref(true)
const error = ref('')
const selectedId = computed(() => typeof route.params.threadId === 'string' ? route.params.threadId : '')
const CLIENTS: Record<string, string> = { claude_code: 'Claude Code', codex: 'Codex', cursor: 'Cursor', claude: 'Claude', other: 'Agent' }
let timer: ReturnType<typeof setInterval> | undefined
let version = 0

async function refresh() {
  const current = ++version
  try {
    const [list, detail] = await Promise.all([listThreads(), selectedId.value ? readThread(selectedId.value) : Promise.resolve(null)])
    if (current !== version) return
    threads.value = list.threads
    thread.value = detail
    error.value = ''
  } catch (cause) {
    if (current === version) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (current === version) loading.value = false
  }
}

watch(selectedId, () => { thread.value = null; void refresh() })
onMounted(() => {
  void refresh()
  timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
})
onBeforeUnmount(() => clearInterval(timer))

const client = (person: RoundtablePerson) => person.client ? CLIENTS[person.client] ?? person.client : ''
const initial = (person: RoundtablePerson) => (person.name ?? '?').trim().slice(0, 1).toUpperCase()
function time(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat(currentLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}
function delivery(message: RoundtableMessage) {
  if (message.kind === 'reply') {
    const mode = message.via?.split(':')[1]
    return mode && ['resume', 'new', 'inbox'].includes(mode) ? t(`roundtable.via.${mode}`) : ''
  }
  if (message.via === 'peer' && message.status === 'sent') return t('roundtable.status.remoteQueued')
  return message.status === 'answered' ? '' : t(`roundtable.status.${message.status}`)
}
</script>

<template>
  <section class="view roundtable-view">
    <GrowthLoading v-if="loading" :label="t('roundtable.loading')" />
    <div v-else-if="error && !threads.length" class="ui-empty" role="alert">
      <p>{{ t('roundtable.loadFailed') }} · {{ error }}</p>
      <button class="ui-button" type="button" @click="refresh">{{ t('roundtable.retry') }}</button>
    </div>
    <div v-else-if="!threads.length" class="roundtable-empty">
      <strong>{{ t('roundtable.empty') }}</strong>
      <p>{{ t('roundtable.emptyHint') }}</p>
    </div>
    <div v-else class="roundtable-layout">
      <nav class="roundtable-threads" :aria-label="t('roundtable.threads')">
        <RouterLink v-for="item in threads" :key="item.id" class="roundtable-thread" :class="{ 'is-active': item.id === selectedId }"
          :to="`/roundtables/${encodeURIComponent(item.id)}`" data-testid="roundtable-thread">
          <span class="roundtable-faces" aria-hidden="true">
            <span v-for="person in item.participants.slice(0, 3)" :key="person.agentId ?? person.name ?? ''">{{ initial(person) }}</span>
          </span>
          <span class="roundtable-thread-copy">
            <strong>{{ item.subject }}</strong>
            <small>{{ item.participants.map((person) => person.name).join(' · ') }}</small>
            <small v-if="item.last" class="roundtable-preview">{{ item.last.from }}：{{ item.last.body }}</small>
          </span>
          <span class="roundtable-thread-meta">
            <time :datetime="item.updatedAt">{{ time(item.updatedAt) }}</time>
            <span v-if="item.waiting" class="ui-badge ui-badge--warning">{{ t('roundtable.waiting') }}</span>
          </span>
        </RouterLink>
      </nav>
      <article v-if="thread" class="roundtable-timeline" data-testid="roundtable-timeline">
        <header>
          <h2>{{ thread.subject }}</h2>
          <p class="ui-meta">{{ t('roundtable.messages', { count: thread.messages.length }) }} · {{ time(thread.createdAt) }}</p>
        </header>
        <ol>
          <li v-for="message in thread.messages" :key="message.id" class="roundtable-message" :class="`is-${message.kind}`">
            <span class="roundtable-avatar" aria-hidden="true">{{ initial(message.from) }}</span>
            <div class="roundtable-bubble">
              <p class="roundtable-byline">
                <strong>{{ message.from.name }}</strong>
                <span v-if="client(message.from)" class="ui-badge">{{ client(message.from) }}</span>
                <span class="ui-meta">{{ t('roundtable.to') }} {{ message.to.name }}</span>
                <time class="ui-meta" :datetime="message.createdAt">{{ time(message.createdAt) }}</time>
              </p>
              <p class="roundtable-body">{{ message.body }}</p>
              <p v-if="delivery(message)" class="roundtable-delivery">{{ delivery(message) }}</p>
            </div>
          </li>
        </ol>
      </article>
      <p v-else class="roundtable-select ui-meta">{{ t('roundtable.select') }}</p>
    </div>
  </section>
</template>

<style scoped>
.roundtable-view { display: flex; flex-direction: column; overflow: hidden; }
.roundtable-empty { max-width: 520px; margin: 12vh auto 0; text-align: center; }
.roundtable-empty strong { font-size: 16px; font-weight: 600; }
.roundtable-empty p { margin-top: 8px; color: var(--color-muted); }
.roundtable-layout { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); flex: 1; min-height: 0; border: 1px solid var(--color-border); border-radius: var(--radius-card); background: var(--color-surface); overflow: hidden; }
.roundtable-threads { min-height: 0; overflow-y: auto; border-right: 1px solid var(--color-border); background: var(--color-bg); }
.roundtable-thread { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--color-border); color: var(--color-ink); text-decoration: none; transition: background-color var(--motion-fast); }
.roundtable-thread:hover { background: var(--color-surface-hover); }
.roundtable-thread.is-active { background: var(--color-surface); box-shadow: inset 3px 0 0 var(--color-accent); }
.roundtable-faces { display: flex; padding-top: 2px; }
.roundtable-faces span, .roundtable-avatar { display: grid; width: 26px; height: 26px; place-items: center; border: 2px solid var(--color-bg); border-radius: 50%; color: var(--color-accent); background: var(--color-accent-soft); font-size: 12px; font-weight: 650; }
.roundtable-faces span + span { margin-left: -9px; }
.roundtable-thread-copy { display: grid; gap: 2px; min-width: 0; }
.roundtable-thread-copy strong { overflow: hidden; font-size: 14px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.roundtable-thread-copy small { overflow: hidden; color: var(--color-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.roundtable-preview { color: var(--color-faint) !important; }
.roundtable-thread-meta { display: grid; justify-items: end; align-content: start; gap: 6px; color: var(--color-faint); font-size: 11px; white-space: nowrap; }
.roundtable-timeline { display: flex; flex-direction: column; min-height: 0; }
.roundtable-timeline header { padding: 20px 28px 14px; border-bottom: 1px solid var(--color-border); }
.roundtable-timeline h2 { font-size: 17px; overflow-wrap: anywhere; }
.roundtable-timeline ol { flex: 1; min-height: 0; overflow-y: auto; margin: 0; padding: 20px 28px 32px; list-style: none; display: grid; align-content: start; gap: 18px; }
.roundtable-message { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; max-width: 760px; }
.roundtable-message.is-reply { margin-left: 42px; }
.roundtable-avatar { width: 30px; height: 30px; border: 0; }
.roundtable-message.is-reply .roundtable-avatar { color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.roundtable-bubble { min-width: 0; }
.roundtable-byline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
.roundtable-byline > * { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
.roundtable-byline strong { font-size: 14px; font-weight: 600; }
.roundtable-body { padding: 12px 14px; border: 1px solid var(--color-border); border-radius: 4px 12px 12px 12px; background: var(--color-bg); color: var(--color-ink); font-size: 14px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.roundtable-message.is-reply .roundtable-body { background: var(--color-surface); }
.roundtable-delivery { margin-top: 6px; color: var(--color-faint); font-size: 12px; }
.roundtable-select { align-self: center; justify-self: center; }
@media (max-width: 860px) {
  .roundtable-layout { grid-template-columns: minmax(0, 1fr); }
  .roundtable-threads { max-height: 40vh; border-right: 0; border-bottom: 1px solid var(--color-border); }
  .roundtable-message.is-reply { margin-left: 16px; }
}
@media (max-width: 480px) {
  .roundtable-timeline header { padding: 16px; }
  .roundtable-timeline ol { padding: 16px; }
  .roundtable-message { gap: 8px; }
  .roundtable-message.is-reply { margin-left: 8px; }
}
</style>
