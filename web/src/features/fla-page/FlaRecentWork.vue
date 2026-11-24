<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { useNow } from '@/composables/useNow'
import { currentLocale, t } from '@/i18n'
import { formatRelativeTime } from '@/lib/relative-time'
import type { FinishedWork } from './fla-now'

// 最近做完 (docs/fla-page.md): what the FLA finished and how it turned out,
// newest first — the title, one line of its recorded result, when. A failed
// task says so in words as well as colour. The title opens the task.
const props = defineProps<{ work: FinishedWork[]; projectName: (id: string) => string }>()
const SHOWN = 5

const expanded = ref(false)
const shown = computed(() => (expanded.value ? props.work : props.work.slice(0, SHOWN)))
const clock = useNow()
const when = (at: string | null) => formatRelativeTime(at, currentLocale(), clock.value) ?? ''
</script>

<template>
  <section v-if="work.length" class="recent" aria-labelledby="fla-recent-heading" data-fla-recent>
    <h2 id="fla-recent-heading" class="recent-label">{{ t('flaPage.recent.title') }} <span class="ui-num">{{ work.length }}</span></h2>
    <ul class="recent-list">
      <li v-for="item in shown" :key="item.taskId" class="recent-row" :data-recent-task="item.taskId">
        <div class="recent-main">
          <RouterLink class="recent-title" :to="{ query: { task: item.taskId } }" :title="item.title">{{ item.title }}</RouterLink>
          <p class="recent-result" :title="item.result ?? undefined">
            <span v-if="item.failed" class="recent-failed">{{ t('flaPage.recent.failed') }}</span>
            {{ item.result ?? t('flaPage.recent.noResult') }}
          </p>
        </div>
        <span class="recent-when">
          <template v-if="item.projectId">{{ projectName(item.projectId) }} · </template>{{ when(item.at) }}
        </span>
      </li>
    </ul>
    <Button v-if="work.length > SHOWN" class="recent-more" size="sm" variant="link" @click="expanded = !expanded">
      {{ expanded ? t('flaPage.recent.less') : t('flaPage.recent.more', { count: work.length }) }}
    </Button>
  </section>
</template>

<style scoped>
.recent { display: grid; gap: 8px; }
.recent-label { display: flex; align-items: baseline; gap: 8px; margin: 0; color: var(--color-ink-soft); font-size: var(--text-control); font-weight: var(--weight-strong); }
.recent-label .ui-num { color: var(--color-faint); font-weight: var(--weight-medium); }
/* One surface, rows split by hairlines. */
.recent-list { margin: 0; padding: 0 16px; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); list-style: none; }
.recent-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; padding: 10px 0; }
.recent-row + .recent-row { border-top: 1px solid var(--color-border); }
.recent-main { display: grid; gap: 2px; min-width: 0; }
.recent-title { overflow: hidden; color: var(--color-ink); font-size: var(--text-body); font-weight: var(--weight-medium); text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
.recent-title:hover { text-decoration: underline; }
.recent-result { margin: 0; overflow: hidden; color: var(--color-ink-soft); font-size: var(--text-meta); text-overflow: ellipsis; white-space: nowrap; }
.recent-failed { color: var(--color-danger); font-weight: var(--weight-medium); }
.recent-when { flex: none; color: var(--color-muted); font-size: var(--text-meta); white-space: nowrap; }
.recent-more { justify-self: start; user-select: none; }
</style>
