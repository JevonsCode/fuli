<script setup lang="ts">
import { computed, ref, toRef } from 'vue'
import UiDisclosure from '@/components/UiDisclosure.vue'
import { Button } from '@/components/ui/button'
import { repositoryName, saveFlaKit, toggled, type KitReference } from '@/features/occupation-kits/occupation-kits'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { kitPending, useFlaKit } from './kit-read'

// Widget 'fla-kit': the starter kit of this FLA's occupation, where it came
// from, and which recommended Skills and MCP servers the person enabled. One
// click turns one on or off; every earlier answer is kept on the server. An
// occupation without a kit (or a server that cannot say) shows nothing.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string }>()

const store = useConsoleStore()
const read = useFlaKit(toRef(props, 'spaceId'), toRef(props, 'agentId'))
const kit = read.kit
const busy = ref<string | null>(null)
// Answers still owed (never chosen, or chosen for an older kit) keep it open, with the summary saying so.
const pending = computed(() => kitPending(kit.value))

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
    read.set(await saveFlaKit(props.spaceId, props.agentId, next.skills, next.mcpServers))
    store.notify(t(item.enabled ? 'flaPage.kit.disabled' : 'flaPage.kit.enabled', { item: item.name, name: props.agentName }))
  } catch (cause) {
    store.reportError(cause)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <!-- Configuration a person touches once: folded once answered, open while an answer is owed (docs/fla-page.md). -->
  <section v-if="plugin" id="fla-kit" class="kit" aria-labelledby="fla-kit-heading" data-widget="fla-kit">
    <h2 id="fla-kit-heading" class="ui-sr-only">{{ t('flaPage.kit.title') }}</h2>
    <UiDisclosure class="kit-card" :title="t('flaPage.kit.title')" :open="Boolean(pending)" data-kit-fold>
      <template #summary>
        <span v-if="pending" class="kit-summary is-pending" data-kit-pending>{{ t(pending.outdated ? 'flaPage.kit.pendingUpdate' : 'flaPage.kit.pendingFirst') }}</span>
        <span v-else class="kit-summary">{{ plugin.role.name }} · <span class="ui-num">{{ plugin.version }}</span></span>
      </template>
      <div class="kit-body">
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
      </div>
    </UiDisclosure>
  </section>
</template>

<style scoped>
.kit { display: grid; }
.kit-card { padding: 0 20px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.kit-card :deep(> summary) { padding-block: 14px; color: var(--color-ink-soft); font-size: var(--text-control); }
.kit-card[open] :deep(> summary) { margin-bottom: 0; }
.kit-summary.is-pending { color: var(--color-warning); }
.kit-summary { margin-left: auto; overflow: hidden; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.kit-body { display: grid; gap: 12px; padding-bottom: 16px; }
.kit-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.kit-hint a { color: inherit; }
.kit-group { display: grid; gap: 6px; }
.kit-group-title { margin: 0; color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-medium); }
.kit-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; user-select: none; }
</style>
