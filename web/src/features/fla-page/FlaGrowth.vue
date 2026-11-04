<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { itemEditPath } from '@/features/knowledge-quick-edit/model'
import { t } from '@/i18n'
import { useConsoleStore } from '@/stores/console'
import { dropExperience, keepExperience, readAgentGrowth, type AgentGrowth, type GrowthItem } from './agent-growth'

// Widget 'fla-growth' (rec#78): what this FLA learned by doing, the ones later
// tasks used first. The person keeps or drops each; nothing else changes it.
// Nothing learned yet (or a server that cannot say) shows nothing at all.
const props = defineProps<{ spaceId: string; agentId: string; agentName: string; projectName: (id: string) => string }>()
const SHOWN = 3

const store = useConsoleStore()
const growth = ref<AgentGrowth | null>(null)
const loading = ref(true)
const expanded = ref(false)
const busy = ref<string | null>(null)
let controller: AbortController | null = null
async function load() {
  controller?.abort()
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const result = await readAgentGrowth(props.spaceId, props.agentId, current.signal)
    if (controller === current) growth.value = result
  } catch (cause) {
    if (controller !== current || (cause instanceof DOMException && cause.name === 'AbortError')) return
    growth.value = null
  } finally {
    if (controller === current) loading.value = false
  }
}
watch(() => [props.spaceId, props.agentId], () => { if (props.spaceId && props.agentId) void load() }, { immediate: true })
onBeforeUnmount(() => controller?.abort())

const items = computed(() => growth.value?.items ?? [])
const visible = computed(() => expanded.value ? items.value : items.value.slice(0, SHOWN))
const waiting = computed(() => items.value.filter(item => item.proven && item.status !== 'confirmed').length)
// An FLA in several projects says which one each experience belongs to.
const severalProjects = computed(() => new Set(items.value.map(item => item.personalProjectId)).size > 1)
const meta = (item: GrowthItem) => [item.uses ? t('flaPage.growth.used', { uses: item.uses, tasks: item.tasks }) : t('flaPage.growth.unused'),
  ...(severalProjects.value ? [props.projectName(item.personalProjectId)] : [])].join(' · ')
const link = (item: GrowthItem) => itemEditPath(props.spaceId, { item_kind: 'entity', item_id: item.itemId })

async function decide(item: GrowthItem, keep: boolean) {
  if (busy.value) return
  busy.value = `${item.itemId}:${keep ? 'keep' : 'drop'}`
  try {
    await (keep ? keepExperience : dropExperience)(props.spaceId, item)
    if (growth.value) growth.value = { ...growth.value, items: keep
      ? items.value.map(entry => entry.itemId === item.itemId ? { ...entry, status: 'confirmed' } : entry)
      : items.value.filter(entry => entry.itemId !== item.itemId) }
    store.notify(t(keep ? 'flaPage.growth.kept' : 'flaPage.growth.dropped', { title: item.title }), { to: link(item) })
  } catch (cause) {
    store.reportError(cause)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section v-if="loading || items.length" class="growth" aria-labelledby="fla-growth-heading" data-widget="fla-growth">
    <h2 id="fla-growth-heading" class="growth-label">{{ t('flaPage.growth.title') }} <span v-if="items.length" class="ui-num">{{ growth?.counts.total }}</span></h2>
    <GrowthLoading v-if="loading && !items.length" variant="compact" :label="t('flaPage.growth.loading', { name: agentName })" />
    <Card v-else class="growth-card">
      <p v-if="waiting" class="growth-hint">{{ t('flaPage.growth.waiting', { count: waiting }) }}</p>
      <TransitionGroup name="ui-list" tag="ul" class="growth-list">
        <li v-for="item in visible" :key="item.itemId" class="growth-row" :data-status="item.status">
          <div class="growth-main">
            <RouterLink class="growth-title" :to="link(item)" :title="item.solution">{{ item.title }}</RouterLink>
            <span class="growth-meta">{{ meta(item) }}</span>
          </div>
          <div class="growth-actions">
            <span v-if="item.status === 'confirmed'" class="growth-kept">{{ t('flaPage.growth.keptLabel') }}</span>
            <template v-else>
              <Button size="sm" variant="outline" :loading="busy === `${item.itemId}:keep`" :disabled="Boolean(busy)" @click="decide(item, true)">{{ t('flaPage.growth.keep') }}</Button>
              <Button size="sm" variant="ghost" :loading="busy === `${item.itemId}:drop`" :disabled="Boolean(busy)" @click="decide(item, false)">{{ t('flaPage.growth.drop') }}</Button>
            </template>
          </div>
        </li>
      </TransitionGroup>
      <p v-if="growth?.partial" class="growth-hint" role="status">{{ t('flaPage.growth.partial') }}</p>
      <Button v-if="items.length > SHOWN" class="growth-more" size="sm" variant="link" @click="expanded = !expanded">
        {{ expanded ? t('flaPage.growth.less') : t('flaPage.growth.more', { count: items.length }) }}
      </Button>
    </Card>
  </section>
</template>

<style scoped>
.growth { display: grid; gap: 12px; }
.growth-label { display: flex; align-items: baseline; gap: 8px; margin: 0; padding-inline: 4px; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.growth-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
.growth-card { gap: 8px; padding: 12px 24px; }
.growth-hint { margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.growth-list { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; }
.growth-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: var(--control-height); }
.growth-main { display: grid; min-width: 0; }
.growth-title { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.growth-title:hover { text-decoration: underline; }
.growth-meta { color: var(--color-muted); font-size: var(--text-meta); }
/* Both answers keep their place whichever row is busy or kept. */
.growth-actions { display: flex; flex: none; justify-content: flex-end; gap: 4px; min-width: 132px; user-select: none; }
.growth-kept { color: var(--color-muted); font-size: var(--text-meta); }
.growth-more { justify-self: start; user-select: none; }
</style>
