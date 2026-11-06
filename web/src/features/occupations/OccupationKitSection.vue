<script setup lang="ts">
import { computed, ref } from 'vue'
import { pluginFor, readOccupationPlugins, repositoryName, sourceOf, type OccupationPluginList } from '@/features/occupation-kits/occupation-kits'
import { t } from '@/i18n'

// The quick look's 起步包: the starter kit FULI curated for this occupation
// from an open-source collection, with the source, its license and what the
// kit recommends. An occupation without a kit, or a server that cannot say,
// shows nothing. The plugin list is read once for the whole console.
const props = defineProps<{ occupation: string }>()

const list = ref<OccupationPluginList | null>(null)
void plugins().then(value => { list.value = value })

const plugin = computed(() => pluginFor(list.value, props.occupation))
const source = computed(() => plugin.value ? sourceOf(list.value, plugin.value) : null)
</script>

<script lang="ts">
let shared: Promise<OccupationPluginList | null> | null = null
function plugins() {
  shared ??= readOccupationPlugins().catch(() => { shared = null; return null })
  return shared
}
</script>

<template>
  <section v-if="plugin" class="grid gap-1 border-t pt-4 text-sm" :aria-label="t('occupations.kit.title')" data-occupation-kit>
    <h3 class="m-0 text-xs font-semibold text-muted-foreground">{{ t('occupations.kit.title') }}</h3>
    <p class="m-0 leading-relaxed [overflow-wrap:anywhere]">
      <a :href="plugin.role.url" target="_blank" rel="noreferrer" data-occupation-kit-source>{{ repositoryName(plugin.role.url) }} · {{ plugin.role.name }}</a>
      <span v-if="source" class="text-muted-foreground"> · {{ source.license }}</span>
    </p>
    <p class="m-0 text-muted-foreground">{{ t('occupations.kit.pieces', { checklist: plugin.checklistCount, acceptance: plugin.acceptanceCount }) }}</p>
    <p v-if="plugin.skills.length" class="m-0 [overflow-wrap:anywhere]">
      <span class="text-muted-foreground">{{ t('occupations.kit.skills') }}</span>
      <template v-for="(item, index) in plugin.skills" :key="item.id">{{ index ? '、' : '' }}<a :href="item.url" target="_blank" rel="noreferrer" :title="`${item.summary} (${item.license})`">{{ item.name }}</a></template>
    </p>
    <p v-if="plugin.mcpServers.length" class="m-0 [overflow-wrap:anywhere]">
      <span class="text-muted-foreground">{{ t('occupations.kit.mcpServers') }}</span>
      <template v-for="(item, index) in plugin.mcpServers" :key="item.id">{{ index ? '、' : '' }}<a :href="item.url" target="_blank" rel="noreferrer" :title="`${item.summary} (${item.license})`">{{ item.name }}</a></template>
    </p>
  </section>
</template>
