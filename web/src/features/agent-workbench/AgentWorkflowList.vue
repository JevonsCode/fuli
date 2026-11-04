<script setup lang="ts">
import { computed, ref } from 'vue'

import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { t } from '@/i18n'
import { UiIconButton } from '@/ui'
import AgentWorkflowCard from './AgentWorkflowCard.vue'
import { openWorkflows, type AgentWorkflow } from './agent-workflows'
import { matchesWorkflow, WORKFLOW_SEARCH_FROM, workflowShown, workflowState } from './workflow-card'

// An FLA's workflows (rec#60 D-78). One is shown whole; several are an index of
// cards, with a search once there are many. Any of them opens over the whole
// app, closed like a floating layer (Jevons 11-04).
const props = defineProps<{ workflows: AgentWorkflow[] }>()
const emit = defineEmits<{ changed: [] }>()

const shown = computed(() => openWorkflows(props.workflows))
const query = ref('')
const listed = computed(() => shown.value.filter(workflow => matchesWorkflow(workflow, query.value)))
const openId = ref('')
const opened = computed(() => shown.value.find(workflow => workflow.workflowId === openId.value) ?? null)
</script>

<template>
  <section class="agent-workflows" aria-labelledby="agent-workflows-heading">
    <div class="agent-section-heading">
      <h2 id="agent-workflows-heading">{{ t('agentWorkbench.workflows.title') }}</h2>
      <span v-if="shown.length > 1">{{ shown.length }}</span>
      <UiIconButton v-if="shown.length === 1" icon="expand" size="sm" :label="t('employees.fullscreen')" data-workflow-expand @click="openId = shown[0]!.workflowId" />
    </div>
    <p v-if="!shown.length" class="agent-muted">{{ t('agentWorkbench.workflows.none') }}</p>
    <AgentWorkflowCard v-else-if="shown.length === 1" :workflow="shown[0]!" @changed="emit('changed')" />
    <template v-else>
      <Input v-if="shown.length >= WORKFLOW_SEARCH_FROM" v-model="query" type="search" :aria-label="t('agentWorkbench.workflows.search')" :placeholder="t('agentWorkbench.workflows.search')" data-workflow-search />
      <ul class="agent-workflow-index">
        <li v-for="workflow in listed" :key="workflow.workflowId">
          <a href="#" class="agent-workflow-tile" :data-workflow-tile="workflow.workflowId" @click.prevent="openId = workflow.workflowId">
            <span class="agent-workflow-tile-head">
              <strong>{{ workflowShown(workflow).name }}</strong>
              <Badge :variant="workflow.pending ? 'warning' : 'success'">{{ workflowState(workflow) }}</Badge>
            </span>
            <span class="agent-workflow-tile-purpose">{{ workflowShown(workflow).purpose }}</span>
          </a>
        </li>
      </ul>
    </template>
    <Dialog :open="Boolean(opened)" @update:open="(open) => { if (!open) openId = '' }">
      <DialogContent class="agent-workflow-full" data-workflow-full>
        <DialogHeader><DialogTitle>{{ opened ? workflowShown(opened).name : '' }}</DialogTitle></DialogHeader>
        <AgentWorkflowCard v-if="opened" :workflow="opened" @changed="emit('changed')" />
      </DialogContent>
    </Dialog>
  </section>
</template>

<style scoped>
.agent-workflows { display: grid; gap: var(--space-3, 12px); min-width: 0; }
.agent-workflows .agent-section-heading { margin-bottom: 0; }
.agent-workflow-index { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: var(--space-3, 12px); margin: 0; padding: 0; list-style: none; }
.agent-workflow-tile { display: grid; gap: 6px; height: 100%; padding: var(--space-3, 12px) var(--space-4, 16px); border: 1px solid var(--color-border); border-radius: var(--radius-card); color: var(--color-ink); background: var(--color-surface); text-decoration: none; user-select: none; }
.agent-workflow-tile:hover { border-color: var(--color-border-strong); box-shadow: var(--shadow-sm); }
.agent-workflow-tile:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }
.agent-workflow-tile-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.agent-workflow-tile-head strong { min-width: 0; overflow: hidden; font-size: var(--text-body, 14px); font-weight: var(--weight-medium); text-overflow: ellipsis; white-space: nowrap; }
.agent-workflow-tile-purpose { display: -webkit-box; overflow: hidden; color: var(--color-muted); font-size: 13px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
</style>

<style>
/* The dialog renders outside this component: over the whole app, below the window's controls. */
[data-slot="dialog-content"].agent-workflow-full {
  top: 0; left: 0; display: flex; flex-direction: column; width: 100vw; max-width: none; height: 100dvh; max-height: none; overflow: auto;
  padding: calc(16px + var(--desktop-caption-clear, 0px)) var(--page-inline, 24px) 24px; border: 0; border-radius: 0; background: var(--color-bg); transform: none;
}
</style>
