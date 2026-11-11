<script setup lang="ts">
import { computed, ref, useId } from 'vue'

import { Button } from '@/components/ui/button'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import NewSessionPanel from '@/features/client-links/NewSessionPanel.vue'
import { t } from '@/i18n'
import { UiIcon } from '@/ui'

import { organizeSentence } from './project-organizing'

// 「整理」 on a project's 整理 card: a run starts in the person's own AI client,
// with that client's model. The shared new-session panel lists the connected
// clients; one sentence names Astro, the project and, when given, where the
// existing material is. The card shows the notice `done` hands it.
const props = defineProps<{ projectId: string }>()
const emit = defineEmits<{ done: [notice: string] }>()
const open = ref(false)
// Kept while the page is open, so reopening the panel keeps what was typed.
const material = ref('')
const materialId = `organize-material-${useId()}`
const ask = computed(() => organizeSentence({ projectId: props.projectId, material: material.value }))
const openedNotice = (client: string) => t('projects.organizing.opened', { client })

function done(notice: string) {
  open.value = false
  emit('done', notice)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <Button size="sm" variant="outline" class="project-organize-start" data-organizing-start>
        <UiIcon name="ai" :size="14" class="project-organize-start__mark" />{{ t('projects.organizing.start') }}
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" :side-offset="8" :collision-padding="12" class="new-session-popover" data-organizing-panel>
      <NewSessionPanel :title="t('projects.organizing.panelTitle')" :lead="t('projects.organizing.panelLead')" :ask="ask"
        :opened-notice="openedNotice" :copied-notice="t('projects.organizing.copied')" @done="done">
        <Field class="gap-1.5">
          <FieldLabel :for="materialId" class="project-organize-start__label">{{ t('projects.organizing.material') }}</FieldLabel>
          <Input :id="materialId" v-model="material" size="sm" :placeholder="t('projects.organizing.materialPlaceholder')" data-organizing-material />
        </Field>
      </NewSessionPanel>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.project-organize-start { user-select: none; }
.project-organize-start__mark { margin-inline-end: 6px; color: var(--color-ai); fill: currentColor; stroke-width: 1; }
.project-organize-start__label { color: var(--color-muted); font-size: var(--text-meta); font-weight: var(--weight-regular, 400); }
</style>
