<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import Breadcrumb from '@/components/Breadcrumb.vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { usePageTitle } from '@/layouts/page-title'
import { t } from '@/i18n'
import { appPageUrl, readApp, type AgentAppDetail } from './agent-apps'

// A page app inside FULI. It runs in a sandboxed frame (scripts and forms
// only, never the console's origin); FULI serves its files only while the
// run gate accepts the active version, so the page checks that first.
const route = useRoute()
const appId = computed(() => String(route.params.appId ?? ''))
const app = ref<AgentAppDetail | null>(null)
const state = ref<'loading' | 'ready' | 'failed'>('loading')
async function load() {
  state.value = 'loading'
  try {
    app.value = await readApp(appId.value)
    state.value = 'ready'
  } catch {
    state.value = 'failed'
  }
}
watch(appId, () => void load(), { immediate: true })

const title = computed(() => app.value?.versions.find(version => version.version === app.value?.version)?.title ?? app.value?.name ?? '')
usePageTitle(title)
// The 全部应用 crumb goes Back when the list opened this page, keeping its place.
const openedFromApps = /^\/project-agents\/apps(\?|$)/
const runnable = computed(() => app.value?.status === 'active' && app.value.run.status === 'ready')
</script>

<template>
  <section class="view app-viewer" :aria-label="title || t('agentApps.title')">
    <Breadcrumb :parent="{ label: t('agentApps.viewer.back'), to: '/project-agents/apps', from: openedFromApps }" />
    <GrowthLoading v-if="state === 'loading'" :label="t('agentApps.viewer.loading')" />
    <div v-else-if="state === 'failed'" class="app-viewer-empty" role="alert">
      <p>{{ t('agentApps.viewer.failed') }}</p>
      <Button size="sm" variant="outline" @click="load">{{ t('agentApps.retry') }}</Button>
    </div>
    <p v-else-if="!runnable" class="app-viewer-empty" data-app-viewer-blocked>{{ t('agentApps.viewer.notReady') }}</p>
    <iframe v-else class="app-viewer-frame" :src="appPageUrl(appId)" :title="title" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" data-app-frame />
  </section>
</template>

<style scoped>
.app-viewer { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.app-viewer-frame { flex: 1; width: 100%; min-height: 70vh; border: 0; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.app-viewer-empty { display: grid; justify-items: center; gap: 10px; margin: 0; padding: 48px 16px; border-radius: var(--radius-card); color: var(--color-muted); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); text-align: center; }
.app-viewer-empty p { margin: 0; }
</style>
