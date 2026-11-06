<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { z } from 'zod'
import { RouterLink } from 'vue-router'
import { getJson } from '@/api/client'
import { shapeOf } from '@/api/response-shape'
import { Button } from '@/components/ui/button'
import GrowthLoading from '@/components/GrowthLoading.vue'
import { roleName, type ModelRoleId } from '@/features/model-settings/model'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { IconName } from '@/ui/icons'
import UiIcon from '@/ui/UiIcon.vue'
import './workbench-card.css'

// Widget 'recent-notices' (Jevons 11-06): 「最近你可能需要知道的事」, what changed in
// the last two weeks that the person may want to know (a topic made into a project,
// what Dreaming found, what Tonborg confirmed, who joined or left, a model that
// stopped answering, a new version), each with its one quick way in. Seven show;
// 更多 opens the rest. With nothing to say, the card stays away.
const notice = z.looseObject({ id: z.string(), kind: z.string(), at: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])), href: z.string() })
const noticesShape = shapeOf(z.looseObject({ items: z.array(notice) }))
type Notice = z.infer<typeof notice>
const FEED_ROWS = 7
const ICONS: Record<string, IconName> = {
  topic_promoted: 'project', dreaming_found: 'memory', dreaming_stopped: 'warning', tonborg_confirmed: 'check',
  fla_joined: 'agents', fla_left: 'agents', delegated_change: 'settings', model_failing: 'error', update_available: 'refresh',
}

const items = ref<Notice[]>([])
const state = ref<'loading' | 'ready' | 'failed'>('loading')
const expanded = ref(false)
const shown = computed(() => (expanded.value ? items.value : items.value.slice(0, FEED_ROWS)))

onMounted(async () => {
  try {
    items.value = (await getJson('/api/notices', noticesShape)).items.filter(item => item.kind in ICONS)
    state.value = 'ready'
  } catch {
    // The workbench says nothing rather than show a broken card.
    state.value = 'failed'
  }
})

function text(item: Notice) {
  const params = item.kind === 'model_failing' ? { role: roleName(String(item.params.role) as ModelRoleId) } : item.params
  return t(`overview.notices.kinds.${item.kind}`, params)
}
const action = (item: Notice) => t(`overview.notices.actions.${item.kind}`)
const when = (item: Notice) => formatRelativeTime(item.at, currentLocale()) ?? ''
</script>

<template>
  <section v-if="state === 'loading' || items.length" class="workbench-card" aria-labelledby="recent-notices-heading" data-widget="recent-notices">
    <header class="workbench-card-head">
      <h2 id="recent-notices-heading">{{ t('overview.notices.title') }}</h2>
      <Button v-if="items.length > FEED_ROWS" variant="ghost" size="sm" :aria-expanded="expanded" data-notices-more @click="expanded = !expanded">
        {{ expanded ? t('overview.more.less') : t('overview.more.more', { count: items.length - FEED_ROWS }) }}
      </Button>
    </header>
    <GrowthLoading v-if="state === 'loading'" variant="compact" :label="t('overview.notices.loading')" />
    <TransitionGroup v-else name="ui-list" tag="ul" class="workbench-rows">
      <li v-for="item in shown" :key="item.id" class="workbench-row" :data-notice="item.kind">
        <span class="recent-notice-mark" :class="{ 'is-problem': item.kind === 'model_failing' || item.kind === 'dreaming_stopped' }" aria-hidden="true">
          <UiIcon :name="ICONS[item.kind]" :size="16" />
        </span>
        <div class="workbench-row-text">
          <p class="workbench-row-title workbench-clamp recent-notice-text">{{ text(item) }}</p>
          <time class="workbench-meta" :datetime="item.at">{{ when(item) }}</time>
        </div>
        <Button as-child variant="outline" size="sm"><RouterLink :to="item.href" data-notice-go>{{ action(item) }}</RouterLink></Button>
      </li>
    </TransitionGroup>
  </section>
</template>

<style scoped>
.recent-notice-mark { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 11px; color: var(--color-ink-soft); background: var(--color-surface-subtle); }
.recent-notice-mark.is-problem { color: var(--color-danger); background: var(--color-danger-soft); }
/* A notice reads in full up to two lines. */
.recent-notice-text { white-space: normal; }
</style>
