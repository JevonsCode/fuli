<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { apiErrorCode, apiErrorReason } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { t } from '@/i18n'
import { UiDialog, UiNotice } from '@/ui'
import { workingProjectNames } from '@/features/projects/project-origin'
import { gaveWayText } from './name-changes'
import { applyNameFixes, keepInstead, readNameFixPlan, type NameFixPlan } from './name-fixes'

// FLAs that shared a name before names were unique keep it, and everything
// works, until the person settles it here. One line says how many names are
// shared; the list shows for each who keeps it, what each other FLA becomes
// and why. The person may let another keep it or leave a rename out; one
// click renames the rest, each with its 原名 kept in its history.
const props = defineProps<{ personalSpaceId: string }>()
const emit = defineEmits<{ settled: [] }>()
const plan = ref<NameFixPlan | null>(null)
const keep = ref<string[]>([])
const leftOut = ref(new Set<string>())
const open = ref(false)
const busy = ref(false)
const error = ref('')
const STATUSES = new Set(['active', 'inactive', 'archived'])
const statusText = (status: string) => STATUSES.has(status) ? t(`flas.names.status.${status}`) : status
const renames = computed(() => (plan.value?.groups ?? []).flatMap(group => group.members)
  .filter(member => !member.keeps && !leftOut.value.has(member.agentId)).length)

async function load() {
  try {
    plan.value = await readNameFixPlan(props.personalSpaceId, keep.value)
  } catch (cause) {
    if (open.value) error.value = t('flas.names.failed', { reason: apiErrorReason(cause) })
    else plan.value = null
  }
}

watch(() => props.personalSpaceId, (space) => {
  keep.value = []
  leftOut.value = new Set()
  plan.value = null
  if (space) void load()
}, { immediate: true })

async function keepThis(agentId: string) {
  if (!plan.value || busy.value) return
  keep.value = keepInstead(plan.value, keep.value, agentId)
  leftOut.value.delete(agentId)
  busy.value = true
  error.value = ''
  await load()
  busy.value = false
}

function toggle(agentId: string, renamed: boolean | 'indeterminate') {
  const next = new Set(leftOut.value)
  if (renamed === true) next.delete(agentId)
  else next.add(agentId)
  leftOut.value = next
}

async function apply() {
  if (!plan.value || !renames.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    plan.value = await applyNameFixes(props.personalSpaceId, plan.value, keep.value, leftOut.value)
    keep.value = []
    leftOut.value = new Set()
    open.value = false
    emit('settled')
  } catch (cause) {
    if (apiErrorCode(cause) === 'agent_name_fixes_changed') {
      error.value = t('flas.names.changed')
      await load()
    } else {
      error.value = t('flas.names.failed', { reason: apiErrorReason(cause) })
    }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UiNotice v-if="plan?.groups.length" tone="info" data-flas-name-fixes>
    <p>{{ t('flas.names.shared', { count: plan.groups.length }) }}</p>
    <template #actions>
      <Button size="sm" variant="ghost" data-flas-name-fixes-open @click="error = ''; open = true">{{ t('flas.names.review') }}</Button>
    </template>
  </UiNotice>
  <UiDialog :open="open && Boolean(plan)" :title="t('flas.names.title')" :description="t('flas.names.rule')" size="lg"
    :busy="busy" :error="error" @close="open = false">
    <section v-for="group in plan?.groups ?? []" :key="group.name" class="name-fix" data-name-fix-group>
      <h3>{{ group.name }}</h3>
      <ul>
        <li v-for="member in group.members" :key="member.agentId" :data-name-fix-member="member.agentId">
          <template v-if="member.keeps">
            <span class="name-fix-who">{{ member.name }}<small data-name-fix-status> · {{ statusText(member.status) }}</small><small v-if="member.projects.length"> · {{ workingProjectNames(member.projects) }}</small></span>
            <span class="name-fix-what">{{ t('flas.names.keeps') }}</span>
          </template>
          <template v-else>
            <label class="name-fix-who">
              <Checkbox :model-value="!leftOut.has(member.agentId)" :disabled="busy" data-name-fix-rename
                @update:model-value="toggle(member.agentId, $event)" />
              <span>{{ member.name }}<small data-name-fix-status> · {{ statusText(member.status) }}</small><small v-if="member.projects.length"> · {{ workingProjectNames(member.projects) }}</small></span>
            </label>
            <span class="name-fix-what">
              {{ leftOut.has(member.agentId) ? t('flas.names.unchanged') : t('flas.names.becomes', { name: member.newName ?? '' }) }}
              <small>{{ gaveWayText(member.gaveWay, group.members.find(item => item.keeps)?.name ?? group.name) }}</small>
            </span>
            <!-- A built-in role always keeps its name: no other may take it over. -->
            <Button v-if="member.gaveWay !== 'built_in_role'" size="sm" variant="ghost" :disabled="busy" data-name-fix-keep
              @click="keepThis(member.agentId)">{{ t('flas.names.keepThis') }}</Button>
          </template>
        </li>
      </ul>
    </section>
    <template #footer>
      <Button variant="ghost" :disabled="busy" @click="open = false">{{ t('flas.names.cancel') }}</Button>
      <Button :disabled="!renames" :loading="busy" data-name-fix-apply @click="apply">{{ t('flas.names.apply', { count: renames }) }}</Button>
    </template>
  </UiDialog>
</template>

<style scoped>
.name-fix + .name-fix { margin-top: 16px; }
.name-fix h3 { margin: 0 0 6px; font-size: var(--text-control); font-weight: var(--weight-strong); }
.name-fix ul { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
.name-fix li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.name-fix-who { display: inline-flex; align-items: center; gap: 8px; min-width: 12rem; color: var(--color-ink); }
.name-fix-who small, .name-fix-what small { color: var(--color-muted); font-size: var(--text-meta); }
.name-fix-what { flex: 1 1 14rem; color: var(--color-ink-soft); }
.name-fix-what small { display: block; }
</style>
