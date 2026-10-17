<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'
import AttentionWorkspace from '@/features/project-agents/AttentionWorkspace.vue'
import { useAgentAttention } from '@/features/project-agents/attention-store'
import { useConsoleStore } from '@/stores/console'
import { t } from '@/i18n'

// "Needs you" is a page, not a modal: requests wait here without interrupting other work.
const store = useConsoleStore()
const route = useRoute()
const attention = useAgentAttention()
const space = computed(() => store.activePersonalSpace?.id ?? '')
const projects = computed(() => (store.state?.personalProjects ?? []).filter(project => project.personal_space_id === space.value))
const agentFilter = computed(() => typeof route.query.agent === 'string' ? route.query.agent : '')
const focusRequest = computed(() => typeof route.query.request === 'string' ? route.query.request : '')

watch([space, agentFilter], ([id, agent]) => {
  if (!id) return
  // Scope first: switching spaces resets the queue, so the open request comes after it.
  attention.setSpace(id)
  attention.show(agent)
}, { immediate: true })
onBeforeUnmount(() => { attention.open = false })
</script>

<template>
  <section class="view inbox-page" :aria-label="t('attention.title')">
    <AttentionWorkspace v-if="space" :personal-space-id="space" :projects="projects" :focus-request-id="focusRequest" />
  </section>
</template>

<style scoped>
.inbox-page {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: var(--page-max);
  margin-inline: auto;
}
</style>
