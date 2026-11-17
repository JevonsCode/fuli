<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { computed, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { t } from '@/i18n'
import type { UnassignedConversationItem } from './unassigned-conversations'
import {
  acceptTopicProposal,
  declineTopicProposal,
  readTopicProposals,
  undoTopicPromotion,
  type TopicFormation,
  type TopicProposal,
} from './topic-proposals'

// Astro's projects from recurring topics: with topicPromotion 'ask' it asks
// here first; with 'auto' (rec#11 D-86) the receipt's link opens this page on
// the project it formed, to open it (rename, move) or undo it.
const props = defineProps<{
  spaceId: string
  items: readonly UnassignedConversationItem[]
}>()
const emit = defineEmits<{ formed: [formation: TopicFormation] }>()

const proposals = ref<TopicProposal[]>([])
const loading = ref(false)
const loadError = ref(false)
const pending = ref<{ topic: string, action: 'accept' | 'decline' } | null>(null)
const actionError = ref('')
const formed = ref<TopicFormation | null>(null)
const declined = ref('')
let sequence = 0

const route = useRoute()
const promoted = computed(() => {
  const project = route?.query.promoted
  const topic = route?.query.topic
  return typeof project === 'string' && project && typeof topic === 'string' && topic ? { project, topic } : null
})
const undoing = ref(false)
const undoError = ref('')
const undone = ref<{ topic: string, archived: boolean, returned: number, kept: number } | null>(null)

async function undo() {
  if (!promoted.value || undoing.value) return
  undoing.value = true
  undoError.value = ''
  try {
    const result = await undoTopicPromotion(props.spaceId, promoted.value.topic, promoted.value.project)
    undone.value = { topic: promoted.value.topic, archived: result.project_archived,
      returned: result.knowledge_returned, kept: result.knowledge_kept }
    void load()
  } catch {
    undoError.value = t('agentRedesign.topicProposal.undoError', { topic: promoted.value.topic })
  } finally {
    undoing.value = false
  }
}

async function load() {
  const current = ++sequence
  loading.value = true
  loadError.value = false
  try {
    const list = await readTopicProposals(props.spaceId)
    if (current === sequence) proposals.value = list
  } catch {
    if (current === sequence) loadError.value = true
  } finally {
    if (current === sequence) loading.value = false
  }
}

watch(() => props.spaceId, () => {
  proposals.value = []
  formed.value = null
  declined.value = ''
  void load()
}, { immediate: true })

// A few opening lines show what the topic has been about.
function samples(proposal: TopicProposal) {
  const key = proposal.topic.trim().toLowerCase()
  return props.items.filter(item => item.topic?.trim().toLowerCase() === key && item.openingLine)
    .slice(0, 3).map(item => item.openingLine)
}

async function answer(proposal: TopicProposal, action: 'accept' | 'decline') {
  if (pending.value) return
  pending.value = { topic: proposal.topic, action }
  actionError.value = ''
  formed.value = null
  declined.value = ''
  try {
    if (action === 'accept') {
      formed.value = await acceptTopicProposal(props.spaceId, proposal.topic)
      emit('formed', formed.value)
    } else {
      await declineTopicProposal(props.spaceId, proposal.topic)
      declined.value = proposal.topic
    }
    proposals.value = proposals.value.filter(item => item.topic !== proposal.topic)
  } catch {
    actionError.value = t(`agentRedesign.topicProposal.${action}Error`, { topic: proposal.topic })
  } finally {
    pending.value = null
  }
}

const busy = (proposal: TopicProposal, action: 'accept' | 'decline') =>
  pending.value?.topic === proposal.topic && pending.value.action === action
</script>

<template>
  <section class="topic-proposals" data-topic-proposals>
    <article v-if="promoted && !undone" class="ui-card topic-proposal" data-topic-promoted>
      <p class="ui-meta topic-proposal-eyebrow">{{ t('agentRedesign.topicProposal.promotedEyebrow') }}</p>
      <h3 class="topic-proposal-title">{{ promoted.topic }}</h3>
      <p class="topic-proposal-question">{{ t('agentRedesign.topicProposal.promoted') }}</p>
      <div class="topic-proposal-actions">
        <Button as-child size="sm">
          <RouterLink :to="`/personal/${encodeURIComponent(spaceId)}/projects/${encodeURIComponent(promoted.project)}/directory`" data-topic-promoted-open>
            {{ t('agentRedesign.topicProposal.openPromoted') }}
          </RouterLink>
        </Button>
        <Button size="sm" variant="ghost" data-topic-promoted-undo :loading="undoing"
          :loading-label="t('agentRedesign.topicProposal.undoing', { topic: promoted.topic })" @click="undo">
          {{ t('agentRedesign.topicProposal.undo') }}
        </Button>
      </div>
      <p v-if="undoError" class="ui-meta" role="alert">{{ undoError }}</p>
    </article>
    <p v-if="undone" class="ui-meta" role="status" data-topic-undone>
      {{ t(undone.archived ? 'agentRedesign.topicProposal.undone' : 'agentRedesign.topicProposal.undoneKept', { topic: undone.topic }) }}
      <template v-if="undone.returned || undone.kept">
        {{ t(undone.kept ? 'agentRedesign.topicProposal.knowledgeReturnedKept' : 'agentRedesign.topicProposal.knowledgeReturned',
             { returned: undone.returned, kept: undone.kept }) }}
      </template>
    </p>
    <GrowthLoading v-if="loading && !proposals.length" variant="inline" :label="t('agentRedesign.topicProposal.loading')" />
    <p v-if="loadError" class="ui-meta" role="alert">
      {{ t('agentRedesign.topicProposal.loadError') }}
      <Button size="sm" variant="ghost" @click="load">{{ t('agentProfiles.retry') }}</Button>
    </p>
    <article v-for="proposal in proposals" :key="proposal.topic" class="ui-card topic-proposal" data-topic-proposal>
      <p class="ui-meta topic-proposal-eyebrow">{{ t('agentRedesign.topicProposal.eyebrow') }}</p>
      <h3 class="topic-proposal-title">{{ proposal.topic }}</h3>
      <p class="topic-proposal-question">
        {{ t('agentRedesign.topicProposal.question', { count: proposal.conversations, days: proposal.days }) }}
      </p>
      <ul v-if="samples(proposal).length" class="topic-proposal-samples">
        <li v-for="line in samples(proposal)" :key="line">{{ line }}</li>
      </ul>
      <p class="ui-meta">{{ t('agentRedesign.topicProposal.hint') }}</p>
      <div class="topic-proposal-actions">
        <Button
          size="sm" data-topic-accept
          :loading="busy(proposal, 'accept')"
          :loading-label="t('agentRedesign.topicProposal.accepting', { topic: proposal.topic })"
          :disabled="Boolean(pending)"
          @click="answer(proposal, 'accept')"
        >{{ t('agentRedesign.topicProposal.accept') }}</Button>
        <Button
          size="sm" variant="ghost" data-topic-decline
          :loading="busy(proposal, 'decline')"
          :loading-label="t('agentRedesign.topicProposal.declining', { topic: proposal.topic })"
          :disabled="Boolean(pending)"
          @click="answer(proposal, 'decline')"
        >{{ t('agentRedesign.topicProposal.decline') }}</Button>
      </div>
    </article>
    <p v-if="actionError" class="ui-meta" role="alert">{{ actionError }}</p>
    <p v-if="formed" class="ui-meta" role="status" data-topic-formed>
      {{ t(formed.lead_status === 'ready' ? 'agentRedesign.topicProposal.formed' : 'agentRedesign.topicProposal.formedAwaitingLead',
           { topic: formed.topic, count: formed.conversations }) }}
      <RouterLink :to="{ path: '/project-agents', query: { project: formed.personal_project_id } }">
        {{ t('agentRedesign.topicProposal.openProject') }}
      </RouterLink>
    </p>
    <p v-if="declined" class="ui-meta" role="status" data-topic-declined>
      {{ t('agentRedesign.topicProposal.declined', { topic: declined }) }}
    </p>
  </section>
</template>

<style src="./agent-profile.css" />
