<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageOutline from '@/components/PageOutline.vue'
import { peekItemValue, useRoutePeek } from '@/composables/useRoutePeek'
import AttentionWorkspace from '@/features/project-agents/AttentionWorkspace.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import ReviewList from '@/features/review-list/ReviewList.vue'
import TonborgDelegationSwitch from '@/features/review-list/TonborgDelegationSwitch.vue'
import { useReviewList } from '@/features/review-list/review-store'
import { decisionPageTools } from '@/features/review-list/decision-page-tools'
import { usePageTools } from '@/features/webmcp/usePageTools'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// 待决策 (rec#96): one page with everything that waits for the person —
// Tonborg's questions, pending knowledge, the Agents' requests and what
// Tonborg confirmed for them — and nothing else. Requests wait here without
// interrupting other work; the open request is a quick look in the URL
// (?item=<space>/<request>).
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const attention = useAgentAttention()
const review = useReviewList()
const peek = useRoutePeek()
// Long enough, the page gets its 目录 of groups with their counts (Jevons 11-07).
const pageRoot = ref<HTMLElement | null>(null)
const space = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === space.value))
const agentFilter = computed(() => typeof route.query.agent === 'string' ? route.query.agent : '')
const openRequestId = computed(() => peek.item.value?.spaceId === space.value ? peek.item.value.id : '')
const total = computed(() => review.total + (attention.agentId ? attention.filteredTotal : attention.total))

watch([space, agentFilter], ([id, agent]) => {
  if (!id) return
  // Scope first: switching spaces resets the queue, so the open request comes after it.
  attention.setSpace(id)
  attention.show(agent)
}, { immediate: true })
// Links from elsewhere (home, an Agent's hand) name a request as ?request=<id>
// in the active space; it becomes that request's quick look in place.
watch([() => route.query.request, space], ([request, id]) => {
  if (typeof request !== 'string' || !request || !id) return
  const { request: _linked, ...query } = route.query
  void router.replace({ query: { ...query, item: peekItemValue({ spaceId: id, id: request }) } })
}, { immediate: true })
onBeforeUnmount(() => { attention.open = false })
// The browser's AI agent may propose decisions here (WebMCP); the person allows them with one click.
usePageTools(() => decisionPageTools(review))
</script>

<template>
  <section class="view inbox-page">
    <div ref="pageRoot" class="@container flex w-full flex-col gap-4">
      <header class="inbox-head">
        <h1 class="inbox-head__title" data-inbox-total>{{ total ? t('reviewList.headline', { count: total }) : '' }}</h1>
        <TonborgDelegationSwitch v-if="space" :personal-space-id="space" settings-link @changed="review.refresh()" />
      </header>
      <ReviewList v-if="space" :personal-space-id="space" :projects="projects">
        <AttentionWorkspace :personal-space-id="space" :projects="projects" :open-request-id="openRequestId"
          @open="peek.open({ spaceId: space, id: $event })" @close="peek.close()" />
      </ReviewList>
    </div>
    <PageOutline :content="pageRoot" />
  </section>
</template>

<style scoped>
.inbox-head { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px 16px; min-height: 36px; }
.inbox-head__title { margin: 0; color: var(--color-ink); font-size: 18px; font-weight: var(--weight-strong); line-height: 36px; white-space: nowrap; }
</style>
