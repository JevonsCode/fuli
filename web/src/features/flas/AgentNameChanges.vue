<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { Button } from '@/components/ui/button'
import { agentProfilePath } from '@/features/agent-profile/profile-model'
import { t } from '@/i18n'
import { UiNotice } from '@/ui'
import { gaveWayText, markRenamesSeen, readNameChanges, seenRename, unseenRenames, type AgentRenamed } from './name-changes'

// After FULI gave FLAs that shared a name new ones (graph/23): one line on the
// FLAs page says how many, and opens the whole list here, each FLA a link to
// its page with its 原名 and why it gave the name up. 知道了 hides it in this
// browser until another rename happens. A failed read shows nothing: the
// renames themselves are on each FLA's page.
const props = defineProps<{ personalSpaceId: string }>()
const items = ref<AgentRenamed[]>([])
const seen = ref(seenRename())
const open = ref(false)
const shown = computed(() => unseenRenames(items.value, seen.value))

watch(() => props.personalSpaceId, async (space) => {
  items.value = []
  if (!space) return
  try {
    items.value = await readNameChanges(space)
  } catch {
    items.value = []
  }
}, { immediate: true })

function dismiss() {
  markRenamesSeen(items.value)
  seen.value = seenRename() || items.value.map(item => item.change.until).sort().at(-1) || ''
}
</script>

<template>
  <UiNotice v-if="shown.length" tone="info" data-flas-renamed>
    <p>{{ t('flas.renamed.summary', { count: shown.length }) }}</p>
    <ul v-if="open" class="renamed-list">
      <li v-for="item in shown" :key="item.agentId" data-flas-renamed-item>
        <RouterLink :to="agentProfilePath(personalSpaceId, item.agentId)">{{ item.displayName }}</RouterLink>
        <span>{{ t('flas.renamed.former', { name: item.change.name }) }} · {{ gaveWayText(item) }}</span>
      </li>
    </ul>
    <template #actions>
      <Button size="sm" variant="ghost" :aria-expanded="open" data-flas-renamed-toggle @click="open = !open">
        {{ open ? t('flas.renamed.hide') : t('flas.renamed.show') }}
      </Button>
      <Button size="sm" variant="ghost" data-flas-renamed-dismiss @click="dismiss">{{ t('flas.renamed.dismiss') }}</Button>
    </template>
  </UiNotice>
</template>

<style scoped>
.renamed-list { display: grid; gap: 4px; margin: 6px 0 0; padding: 0; list-style: none; }
.renamed-list li { display: flex; flex-wrap: wrap; gap: 4px 8px; }
.renamed-list a { color: var(--color-ink); font-weight: var(--weight-medium); }
.renamed-list span { color: var(--color-muted); }
</style>
