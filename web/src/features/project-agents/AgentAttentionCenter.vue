<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { t } from '@/i18n'
import type { PersonalProject } from '@/types'
import AgentHand from './AgentHand.vue'
import { inboxLocation, useAgentAttention } from './attention-store'
// Sidebar entry for the inbox page; keeps the pending count fresh in the background.
const props = defineProps<{ personalSpaceId: string; projects: PersonalProject[] }>()
const attention = useAgentAttention()
watch(() => props.personalSpaceId, id => attention.setSpace(id === 'current' ? '' : id), { immediate: true })
let timer: ReturnType<typeof setInterval> | undefined
function refreshVisible() { if (document.visibilityState === 'visible' && !attention.loading && !attention.open) void attention.refresh() }
onMounted(() => { timer = setInterval(refreshVisible, 30000); document.addEventListener('visibilitychange', refreshVisible) })
onBeforeUnmount(() => { clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); attention.setSpace('') })
</script>

<template>
  <RouterLink class="space-nav-button attention-nav" :to="inboxLocation()" :aria-label="attention.total ? `${t('attention.title')} · ${t('attention.count', { count: attention.total })}` : t('attention.title')"><span class="nav-icon nav-icon-review" aria-hidden="true" /><span>{{ t('attention.title') }}</span><span class="attention-nav-status"><AgentHand passive count-only /><span v-if="attention.error" :title="t('attention.loadError')">!</span></span></RouterLink>
</template>

<style src="./attention.css"></style>
