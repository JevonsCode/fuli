<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// /employees/<role> stays a stable link (Jefa's runtime and old notes use it).
// A built-in role's workbench is the first tab of its FLA page, so it lands
// there once the space is known, keeping ?project= and ?item=.
const route = useRoute()
const router = useRouter()
const store = useConsoleStore()
const spaceId = computed(() => store.activePersonalSpace?.id ?? '')
watch(spaceId, (space) => {
  if (space) void router.replace({ path: agentProfilePath(space, `employee.${String(route.params.templateId)}`), query: route.query, hash: route.hash })
}, { immediate: true })
onMounted(() => { if (store.runtimeStatus === 'idle') void store.refresh() })
</script>

<template>
  <section class="view">
    <GrowthLoading :label="t('common.status.loadingConsole')" />
  </section>
</template>
