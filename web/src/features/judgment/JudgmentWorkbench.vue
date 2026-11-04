<script setup lang="ts">
import { ref, watch } from 'vue'

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { PersonalProject } from '@/types'

import JudgmentRecords from './JudgmentRecords.vue'
import JudgmentStandards from './JudgmentStandards.vue'
import { judgmentText } from './judgment-copy'
import type { JudgmentView } from './judgment-types'

// Tonborg's workbench: what it has judged, and what it judges by. The page
// owns the open tab in its URL; without a page (previews, tests) it is local.
const props = withDefaults(defineProps<{ personalSpaceId: string; projects?: PersonalProject[] }>(), { projects: () => [] })
const view = defineModel<JudgmentView>('view', { default: 'records' })

// The standards read their policies the first time they open, then stay, so
// an undo offered there survives a look at the records.
const standardsOpened = ref(false)
watch(view, value => { if (value === 'standards') standardsOpened.value = true }, { immediate: true })
</script>

<template>
  <section class="judgment-workbench" :aria-label="judgmentText('workbench.aria')">
    <Tabs v-model="view" :unmount-on-hide="false" class="judgment-tabs">
      <TabsList :aria-label="judgmentText('workbench.views')">
        <TabsTrigger value="records" data-judgment-view="records">{{ judgmentText('workbench.records') }}</TabsTrigger>
        <TabsTrigger value="standards" data-judgment-view="standards">{{ judgmentText('workbench.standards') }}</TabsTrigger>
      </TabsList>
      <TabsContent value="records" class="judgment-view">
        <JudgmentRecords :active="view === 'records'" :personal-space-id="props.personalSpaceId" :projects="props.projects" />
      </TabsContent>
      <TabsContent value="standards" class="judgment-view is-standards">
        <JudgmentStandards v-if="standardsOpened" :personal-space-id="props.personalSpaceId" :projects="props.projects" />
      </TabsContent>
    </Tabs>
  </section>
</template>

<style scoped>
/* The workbench takes the rest of the page; each tab scrolls inside it, so the
   tabs and the corner actions stay in reach. */
.judgment-workbench { display: flex; flex: 1 1 0; flex-direction: column; min-width: 0; min-height: 0; }
.judgment-tabs { flex: 1 1 0; gap: 12px; min-width: 0; min-height: 0; }
.judgment-view { display: flex; flex: 1 1 0; flex-direction: column; min-height: 0; }
.judgment-view.is-standards { overflow: auto; overscroll-behavior: contain; }
</style>
