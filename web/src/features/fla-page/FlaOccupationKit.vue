<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { readFlaKit, repositoryName, saveFlaKit, toggled, type KitReference, type OccupationKit } from '@/features/occupation-kits/occupation-kits'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'

// Widget 'fla-kit': the starter kit of this FLA's occupation, where it came
// from, and which recommended Skills and MCP servers the person enabled. One
// click turns one on or off; every earlier answer is kept on the server. An
// occupation without a kit (or a server that cannot say) shows nothing.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string }>()

const store = useConsoleStore()
const kit = ref<OccupationKit | null>(null)
const loading = ref(true)
const busy = ref<string | null>(null)
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const result = await readFlaKit(props.spaceId, props.agentId, current.signal)
    if (controller === current) kit.value = result
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    kit.value = null
  } finally {
    if (controller === current) loading.value = false
  }
}
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

const plugin = computed(() => kit.value?.plugin ?? null)
const skills = computed(() => kit.value?.skills ?? [])
const mcpServers = computed(() => kit.value?.mcpServers ?? [])
const source = computed(() => plugin.value ? [repositoryName(plugin.value.role.url), kit.value?.checklist?.from.license].filter(Boolean).join(' · ') : '')

async function flip(list: 'skills' | 'mcpServers', item: KitReference) {
  if (busy.value || !kit.value) return
  busy.value = `${list}:${item.id}`
  try {
    const next = { skills: skills.value.filter(entry => entry.enabled === true).map(entry => entry.id),
      mcpServers: mcpServers.value.filter(entry => entry.enabled === true).map(entry => entry.id) }
    next[list] = toggled(list === 'skills' ? skills.value : mcpServers.value, item.id)
    kit.value = await saveFlaKit(props.spaceId, props.agentId, next.skills, next.mcpServers)
    store.notify(t(item.enabled ? 'flaPage.kit.disabled' : 'flaPage.kit.enabled', { item: item.name, name: props.agentName }))
  } catch (cause) {
    store.reportError(cause)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="loading || plugin" class="kit" aria-labelledby="fla-kit-heading" data-widget="fla-kit">
    <h2 id="fla-kit-heading" class="kit-label">{{ t('flaPage.kit.title') }} <span v-if="plugin" class="ui-num">{{ plugin.version }}</span></h2>
    <GrowthLoading v-if="loading && !plugin" variant="compact" :label="t('flaPage.kit.loading', { name: agentName })" />
    <Card v-else-if="plugin" class="kit-card">
      <p class="kit-hint">
        <a :href="plugin.role.url" target="_blank" rel="noreferrer" data-kit-source>{{ source }}</a>
        · {{ t('flaPage.kit.pieces', { checklist: kit?.checklist?.items.length ?? 0, acceptance: kit?.acceptance?.items.length ?? 0 }) }}
      </p>
      <p v-if="!kit?.choice" class="kit-hint" data-kit-unanswered>{{ t('flaPage.kit.unanswered') }}</p>
      <p v-else-if="kit.choice.outdated" class="kit-hint" data-kit-outdated>{{ t('flaPage.kit.outdated', { version: kit.choice.pluginVersion }) }}</p>
      <div v-for="group in ([['skills', skills], ['mcpServers', mcpServers]] as const)" :key="group[0]" class="kit-group" v-show="group[1].length">
        <h3 class="kit-group-title">{{ t(`flaPage.kit.${group[0]}`) }}</h3>
        <ul class="kit-chips">
          <li v-for="item in group[1]" :key="item.id">
            <Button size="sm" :variant="item.enabled ? 'default' : 'outline'" :aria-pressed="item.enabled === true" :title="item.summary"
              :loading="busy === `${group[0]}:${item.id}`" :disabled="Boolean(busy)" :data-kit-item="item.id" @click="flip(group[0], item)">
              {{ item.name }}
            </Button>
          </li>
        </ul>
      </div>
    </Card>
  </section>
</template>

<style scoped>
.kit { display: grid; gap: 12px; }
.kit-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.kit-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.kit-card { gap: 12px; padding: 12px 24px; }
.kit-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.kit-hint a { color: inherit; }
.kit-group { display: grid; gap: 6px; }
.kit-group-title { margin: 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.kit-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; user-select: none; }
</style>
