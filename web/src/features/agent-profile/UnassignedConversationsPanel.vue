<script setup lang="ts">
import UiButton from '@/ui/UiButton.vue'
import { ref, watch } from "vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import CreateProjectDialog from "@/features/projects/CreateProjectDialog.vue";
import { currentLocale, t } from "@/i18n";
import { formatDateTime } from "@/lib/date-time";
import type { PersonalProject } from "@/types";
import {
  readUnassignedConversations,
  triageUnassignedConversation,
  type UnassignedConversationItem,
} from "./unassigned-conversations";

const props = defineProps<{
  spaceId: string;
  formalProjects: readonly PersonalProject[];
  existingProjectIds: string[];
}>();

const emit = defineEmits<{
  projectCreated: [project: PersonalProject];
}>();

const items = ref<UnassignedConversationItem[]>([]);
const loading = ref(false);
const loadError = ref(false);
const expanded = ref(false);
const movingConversationId = ref<string | null>(null);
const targetProjectId = ref("");
const creatingForItem = ref<UnassignedConversationItem | null>(null);
const busyConversationId = ref<string | null>(null);
const triageError = ref("");
let sequence = 0;

async function load() {
  if (!props.spaceId) {
    items.value = [];
    return;
  }
  const current = ++sequence;
  loading.value = true;
  loadError.value = false;
  try {
    const list = await readUnassignedConversations(props.spaceId);
    if (current === sequence) items.value = list;
  } catch {
    if (current === sequence) loadError.value = true;
  } finally {
    if (current === sequence) loading.value = false;
  }
}

watch(() => props.spaceId, () => {
  void load();
}, { immediate: true });

function triageBadgeText(item: UnassignedConversationItem) {
  const base = t(`agentRedesign.unassigned.triage.${item.triageStatus}`);
  return item.topic ? `${base} · ${item.topic}` : base;
}

function formatStartedAt(value: string | null) {
  return formatDateTime(value, currentLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }, { missing: "" });
}

function startMove(item: UnassignedConversationItem) {
  movingConversationId.value = movingConversationId.value === item.conversationId ? null : item.conversationId;
  targetProjectId.value = item.suggestedProjectId || props.formalProjects[0]?.project_id || "";
  triageError.value = "";
}

async function applyTriage(
  conversationId: string,
  kind: "project" | "one_off",
  personalProjectId?: string | null,
) {
  if (busyConversationId.value) return;
  busyConversationId.value = conversationId;
  triageError.value = "";
  try {
    await triageUnassignedConversation({
      personalSpaceId: props.spaceId,
      conversationId,
      kind,
      personalProjectId,
    });
    items.value = items.value.filter((item) => item.conversationId !== conversationId);
    if (movingConversationId.value === conversationId) movingConversationId.value = null;
  } catch {
    triageError.value = t("agentRedesign.unassigned.triageError");
  } finally {
    busyConversationId.value = null;
  }
}

async function handleProjectCreated(project: PersonalProject) {
  const target = creatingForItem.value;
  creatingForItem.value = null;
  emit("projectCreated", project);
  if (target) {
    await applyTriage(target.conversationId, "project", project.project_id);
  }
}
</script>

<template>
  <section class="unassigned-conversations" data-unassigned-conversations>
    <div class="unassigned-conversations-bar">
      <button
        type="button"
        class="directory-project-toggle unassigned-conversations-toggle"
        data-unassigned-toggle
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        <span class="directory-project-name">
          {{ t("agentRedesign.unassigned.count", { count: items.length }) }}
        </span>
        <GrowthLoading
          v-if="loading"
          variant="inline"
          :label="t('agentRedesign.unassigned.loading')"
        />
        <svg class="directory-project-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <p v-if="loadError" class="ui-meta" role="alert">
        {{ t("agentRedesign.unassigned.loadError") }}
        <UiButton size="sm" variant="ghost" @click="load">{{ t("agentProfiles.retry") }}</UiButton>
      </p>
    </div>

    <div v-if="expanded" class="unassigned-conversations-list" data-unassigned-list>
      <p v-if="triageError" class="ui-meta" role="alert">{{ triageError }}</p>
      <article
        v-for="item in items"
        :key="item.conversationId"
        class="ui-card unassigned-conversation-row"
        data-unassigned-item
      >
        <div class="unassigned-conversation-main">
          <span v-if="item.startedAt" class="ui-meta unassigned-conversation-time">
            {{ formatStartedAt(item.startedAt) }}
          </span>
          <span class="unassigned-conversation-line">{{ item.openingLine }}</span>
          <span class="ui-badge unassigned-conversation-triage" data-unassigned-triage>
            {{ triageBadgeText(item) }}
          </span>
        </div>
        <div class="unassigned-conversation-actions">
          <GrowthLoading
            v-if="busyConversationId === item.conversationId"
            variant="inline"
            :label="t('agentRedesign.unassigned.triaging')"
          />
          <template v-else>
            <UiButton size="sm" variant="ghost"
             
              data-unassigned-move
              @click="startMove(item)"
            >
              {{ t("agentRedesign.unassigned.moveToProject") }}
            </UiButton>
            <UiButton size="sm" variant="ghost"
             
              data-unassigned-create-project
              @click="creatingForItem = item"
            >
              {{ t("agentRedesign.unassigned.createProject") }}
            </UiButton>
            <UiButton size="sm" variant="ghost"
             
              data-unassigned-one-off
              @click="applyTriage(item.conversationId, 'one_off')"
            >
              {{ t("agentRedesign.unassigned.markOneOff") }}
            </UiButton>
          </template>
        </div>
        <div v-if="movingConversationId === item.conversationId" class="unassigned-conversation-picker">
          <select v-model="targetProjectId" :aria-label="t('agentRedesign.unassigned.selectProject')">
            <option
              v-for="project in formalProjects"
              :key="project.project_id"
              :value="project.project_id"
            >
              {{ project.profile.name }}
            </option>
          </select>
          <UiButton size="sm" variant="ghost"
           
            data-unassigned-confirm-move
            :disabled="!targetProjectId"
            @click="applyTriage(item.conversationId, 'project', targetProjectId)"
          >
            {{ t("agentRedesign.unassigned.confirmMove") }}
          </UiButton>
        </div>
      </article>
    </div>

    <CreateProjectDialog
      :open="Boolean(creatingForItem)"
      :personal-space-id="spaceId"
      :existing-project-ids="existingProjectIds"
      :initial-purpose="creatingForItem?.openingLine ?? ''"
      @close="creatingForItem = null"
      @created="handleProjectCreated"
    />
  </section>
</template>
