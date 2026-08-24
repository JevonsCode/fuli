<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getJson, patchJson } from '@/api/client'
import { t } from '@/i18n'
import type { ProjectAgentCoordinationPolicy } from '@/types'

const props = defineProps<{
  personalSpaceId: string
  personalProjectId: string
  projectName: string
}>()

const policy = ref<ProjectAgentCoordinationPolicy>(defaultPolicy())
const loading = ref(false)
const saving = ref(false)
const loadError = ref('')
const saveError = ref('')
const saved = ref(false)
let loadVersion = 0

const busy = computed(() => loading.value || saving.value)

watch(
  () => [props.personalSpaceId, props.personalProjectId] as const,
  () => void loadPolicy(),
  { immediate: true },
)

async function loadPolicy() {
  const version = ++loadVersion
  policy.value = defaultPolicy()
  saved.value = false
  saveError.value = ''
  if (!props.personalSpaceId || !props.personalProjectId) return
  loading.value = true
  loadError.value = ''
  try {
    const query = new URLSearchParams({
      personalSpaceId: props.personalSpaceId,
      personalProjectId: props.personalProjectId,
    })
    const value = await getJson<unknown>(`/api/project-agent-coordination-policy?${query}`)
    if (version === loadVersion) policy.value = normalizePolicy(value)
  } catch (cause) {
    if (version === loadVersion) {
      loadError.value = cause instanceof Error
        ? cause.message
        : t('projectAgents.coordination.loadFailed')
    }
  } finally {
    if (version === loadVersion) loading.value = false
  }
}

async function updatePolicy(
  field: 'askBeforeRecruitment' | 'autoReusePreviousAgent',
  event: Event,
) {
  if (busy.value) return
  const previous = { ...policy.value }
  const checked = (event.currentTarget as HTMLInputElement).checked
  policy.value = { ...policy.value, [field]: checked }
  saving.value = true
  saved.value = false
  saveError.value = ''
  try {
    const value = await patchJson<unknown>('/api/project-agent-coordination-policy', {
      personalSpaceId: props.personalSpaceId,
      personalProjectId: props.personalProjectId,
      askBeforeRecruitment: policy.value.askBeforeRecruitment,
      autoReusePreviousAgent: policy.value.autoReusePreviousAgent,
    })
    policy.value = normalizePolicy(value)
    saved.value = true
  } catch (cause) {
    policy.value = previous
    saveError.value = cause instanceof Error
      ? cause.message
      : t('projectAgents.coordination.saveFailed')
  } finally {
    saving.value = false
  }
}

function defaultPolicy(): ProjectAgentCoordinationPolicy {
  return {
    personalSpaceId: props.personalSpaceId,
    personalProjectId: props.personalProjectId,
    askBeforeRecruitment: true,
    autoReusePreviousAgent: true,
    updatedAt: null,
  }
}

function normalizePolicy(value: unknown): ProjectAgentCoordinationPolicy {
  const record = value && typeof value === 'object'
    ? value as Record<string, unknown>
    : {}
  return {
    personalSpaceId: stringValue(record.personalSpaceId ?? record.personal_space_id)
      || props.personalSpaceId,
    personalProjectId: stringValue(record.personalProjectId ?? record.personal_project_id)
      || props.personalProjectId,
    askBeforeRecruitment: booleanValue(
      record.askBeforeRecruitment ?? record.ask_before_recruitment,
      true,
    ),
    autoReusePreviousAgent: booleanValue(
      record.autoReusePreviousAgent ?? record.auto_reuse_previous_agent,
      true,
    ),
    updatedAt: stringValue(record.updatedAt ?? record.updated_at),
  }
}

function booleanValue(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback
}

function stringValue(value: unknown) {
  return typeof value === 'string' && value ? value : null
}
</script>

<template>
  <section
    class="project-agent-automation-policy"
    :aria-label="t('projectAgents.coordination.aria', { project: projectName })"
    :aria-busy="busy"
  >
    <header>
      <h3>{{ t('projectAgents.coordination.title') }}</h3>
      <span>{{ projectName }}</span>
    </header>

    <p v-if="loading" class="project-agent-policy-state" role="status">
      {{ t('projectAgents.coordination.loading') }}
    </p>
    <div v-else class="project-agent-policy-options">
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.autoReuse') }}</strong>
          <small>{{ t('projectAgents.coordination.autoReuseMeta') }}</small>
        </span>
        <input
          :checked="policy.autoReusePreviousAgent"
          :disabled="busy"
          type="checkbox"
          role="switch"
          @change="updatePolicy('autoReusePreviousAgent', $event)"
        />
      </label>
      <label>
        <span>
          <strong>{{ t('projectAgents.coordination.askBeforeRecruitment') }}</strong>
          <small>{{ t('projectAgents.coordination.askBeforeRecruitmentMeta') }}</small>
        </span>
        <input
          :checked="policy.askBeforeRecruitment"
          :disabled="busy"
          type="checkbox"
          role="switch"
          @change="updatePolicy('askBeforeRecruitment', $event)"
        />
      </label>
    </div>

    <div class="project-agent-policy-feedback" aria-live="polite">
      <p v-if="loadError || saveError" role="alert">
        {{ loadError || saveError }}
        <button v-if="loadError" type="button" :disabled="busy" @click="loadPolicy">
          {{ t('projectAgents.retry') }}
        </button>
      </p>
      <p v-else-if="saving" role="status">{{ t('projectAgents.coordination.saving') }}</p>
      <p v-else-if="saved" role="status">{{ t('projectAgents.coordination.saved') }}</p>
    </div>
  </section>
</template>

<style scoped>
.project-agent-automation-policy {
  display: grid;
  grid-template-columns: minmax(110px, 150px) minmax(0, 1fr);
  align-items: center;
  gap: 14px;
  padding: 11px 0;
  border-block: 1px solid #dfe5e0;
}
.project-agent-automation-policy > header { min-width: 0; }
.project-agent-automation-policy h3 { color: #31453a; font-size: 12px; line-height: 1.35; }
.project-agent-automation-policy header span {
  display: block;
  margin-top: 3px;
  overflow: hidden;
  color: #68756d;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-agent-policy-options {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.project-agent-policy-options label {
  min-width: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 2px 16px;
  cursor: pointer;
}
.project-agent-policy-options label + label { border-inline-start: 1px solid #e2e7e3; }
.project-agent-policy-options label > span { min-width: 0; display: grid; gap: 3px; }
.project-agent-policy-options strong { color: #3d5045; font-size: 10px; line-height: 1.4; }
.project-agent-policy-options small {
  max-width: 54ch;
  color: #6d7971;
  font-size: 9px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.project-agent-policy-options input {
  position: relative;
  width: 34px;
  height: 19px;
  margin: 0;
  appearance: none;
  border: 1px solid #aeb8b1;
  border-radius: 999px;
  background: #e8ece9;
  cursor: pointer;
  transition: background-color 140ms ease-out, border-color 140ms ease-out;
}
.project-agent-policy-options input::after {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 2px rgb(36 55 44 / 22%);
  content: '';
  transition: transform 140ms ease-out;
}
.project-agent-policy-options input:checked { border-color: #3f7658; background: #4d8164; }
.project-agent-policy-options input:checked::after { transform: translateX(15px); }
.project-agent-policy-options input:focus-visible {
  outline: 2px solid #355f49;
  outline-offset: 3px;
}
.project-agent-policy-options input:disabled { cursor: wait; opacity: .62; }
.project-agent-policy-feedback {
  grid-column: 2;
  min-height: 14px;
  padding-inline: 16px;
}
.project-agent-policy-state, .project-agent-policy-feedback p {
  color: #66736b;
  font-size: 9px;
  line-height: 1.45;
}
.project-agent-policy-feedback p[role='alert'] { color: #874b43; }
.project-agent-policy-feedback button {
  margin-inline-start: 6px;
  border: 0;
  padding: 0;
  color: #355f49;
  background: transparent;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}
@media (max-width: 760px) {
  .project-agent-automation-policy { grid-template-columns: minmax(0, 1fr); }
  .project-agent-policy-options { grid-template-columns: minmax(0, 1fr); }
  .project-agent-policy-options label { padding: 8px 0; }
  .project-agent-policy-options label + label { border-inline-start: 0; border-block-start: 1px solid #e2e7e3; }
  .project-agent-policy-feedback { grid-column: 1; padding-inline: 0; }
}
</style>
