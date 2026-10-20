<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { peekItemValue, useRoutePeek } from '@/composables/useRoutePeek'
import AttentionWorkspace from '@/features/project-agents/AttentionWorkspace.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useConsoleStore } from '@/stores/console'

// "Needs you" is a page, not a modal: requests wait here without interrupting other work.
// The open request is a quick look in the URL (?item=<space>/<request>).
const store = useConsoleStore()
const route = useRoute()
const router = useRouter()
const attention = useAgentAttention()
const peek = useRoutePeek()
const space = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === space.value))
const agentFilter = computed(() => typeof route.query.agent === 'string' ? route.query.agent : '')
const openRequestId = computed(() => peek.item.value?.spaceId === space.value ? peek.item.value.id : '')

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
</script>

<template>
  <section class="view inbox-page">
    <div class="@container mx-auto flex w-full max-w-(--canvas-max) flex-col">
      <AttentionWorkspace v-if="space" :personal-space-id="space" :projects="projects" :open-request-id="openRequestId"
        @open="peek.open({ spaceId: space, id: $event })" @close="peek.close()" />
    </div>
  </section>
</template>

<style scoped>
.inbox-page { scrollbar-gutter: stable; }
</style>
