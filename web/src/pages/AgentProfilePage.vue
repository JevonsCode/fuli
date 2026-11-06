<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AgentAvatarPicker from "@/features/agent-profile/AgentAvatarPicker.vue";
import AgentNameEditor from "@/features/agent-profile/AgentNameEditor.vue";
import { agentIdentityStyle } from "@/features/agent-profile/agent-identity-color";
import { headerFolds } from "@/features/agent-profile/header-fold";
import { computed, defineAsyncComponent, defineComponent, h, onMounted, ref, watch, type Component } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { getJson } from "@/api/client";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import Breadcrumb from "@/components/Breadcrumb.vue";
import PageOutline from "@/components/PageOutline.vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import UiDisclosure from "@/components/UiDisclosure.vue";
import AgentProfileSettings from "@/features/agent-profile/AgentProfileSettings.vue";
import AgentOccupationEditor from "@/features/agent-profile/AgentOccupationEditor.vue";
import { useOccupationCatalog } from "@/features/occupations/occupation-catalog";
import AgentConversations from "@/features/project-agents/AgentConversations.vue";
import EmployeeWorkHistory from "@/features/project-agents/EmployeeWorkHistory.vue";
import WidgetSlot from "@/widgets/WidgetSlot.vue";
import {
  agentDisplayName,
  agentProfilePath,
  agentResponsibility,
  collaboratorsFor,
  mentionPartner,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import AgentMentionCopy from "@/features/agent-profile/AgentMentionCopy.vue";
import AgentHeaderTags from "@/features/agent-profile/AgentHeaderTags.vue";
import AgentRenameHint from "@/features/agent-profile/AgentRenameHint.vue";
import { mentionKind } from "@/features/agent-profile/fla-mention";
import { isAgentTaskDataComplete, taskHasAgent } from "@/features/agent-profile/agent-work-summary";
import { useAgentRecords } from "@/features/agent-profile/useAgentRecords";
import {
  arrayOf,
  normalizeAssignment,
  normalizeTask,
  unknownRecord,
} from "@/features/project-agents/task-evidence";
import { employeeTemplateIdForAgent } from "@/features/employees/catalog";
import type {
  ProjectAgentAssignmentRecord,
  ProjectAgentRecord,
  ProjectAgentTaskRecord,
} from "@/types";
import { personalProjectsPath } from "@/router/paths";
import { usePageTitle } from "@/layouts/page-title";
import { openWorkflows, readAgentWorkflows, type AgentWorkflow } from "@/features/agent-workbench/agent-workflows";
import AgentWorkflowList from "@/features/agent-workbench/AgentWorkflowList.vue";
import { usePageRefresh } from "@/layouts/page-refresh";

// The Workbench and the management sections load only when their tab opens (rec#60 D-78).
const tabPanel = (loader: () => Promise<Component>, label: string) => defineAsyncComponent({
  loader,
  loadingComponent: defineComponent(() => () => h(GrowthLoading, { variant: "compact", label: t(label) })),
  delay: 0,
});
const EmployeeWorkbench = tabPanel(() => import("@/features/employees/EmployeeWorkbench.vue"), "agentWorkbench.opening");
const AgentManagement = tabPanel(() => import("@/features/project-agents/AgentManagement.vue"), "agentProfiles.detailLoading");

type ProfileTab = "workbench" | "overview" | "settings";

const route = useRoute();
const router = useRouter();
const store = useConsoleStore();
const space = computed(() => store.activePersonalSpace?.id ?? "");
// Only this Agent is read; the Provider resolves a legacy id to its current record.
const routeAgentId = computed(() =>
  route.params.spaceId === space.value ? String(route.params.agentId ?? "") : "",
);
const self = useAgentRecords(space, computed(() => (routeAgentId.value ? [routeAgentId.value] : [])));
const { loading, error } = self;
const load = () => self.load({ force: true });
const agent = computed(() =>
  routeAgentId.value ? self.records.value[routeAgentId.value] : undefined,
);
const projects = computed(() =>
  (store.state?.personalProjects ?? []).filter(
    (item) => item.personal_space_id === space.value,
  ),
);
const projectName = (id: string) =>
  projects.value.find((item) => item.project_id === id)?.profile.name || id;

const tasks = ref<ProjectAgentTaskRecord[]>([]);
const assignments = ref<ProjectAgentAssignmentRecord[] | undefined>(undefined);
const workflows = ref<AgentWorkflow[]>([]);
const detailsLoading = ref(false);
const partial = ref(false);

// One page per FLA, flat (Jevons 11-04): an FLA has no tabs, only one page to
// read. A built-in role also has its Workbench, which needs the room to itself:
// that is the one reason for tabs here. 设置 is the header's button.
const employeeId = computed(() => (agent.value ? employeeTemplateIdForAgent(agent.value) : null));
const hasWorkbench = computed(() => Boolean(employeeId.value));
const hasWorkflows = computed(() => openWorkflows(workflows.value).length > 0);
const defaultTab = computed<ProfileTab>(() => (hasWorkbench.value ? "workbench" : "overview"));
const profileTabs = computed<Array<{ id: ProfileTab; label: string }>>(() => hasWorkbench.value
  ? [{ id: "workbench", label: t("agentProfiles.workbench") }, { id: "overview", label: t("agentProfiles.workRecord") }]
  : [{ id: "overview", label: t("agentProfiles.workRecord") }]);
// The open tab is part of the URL (?tab=), so a refresh or a shared link
// lands on it; switching tabs replaces the entry instead of adding history.
const activeTab = computed<ProfileTab>({
  get: () => {
    const tab = route.query.tab;
    // 设置 is the header's button, not one of the tabs.
    if (tab === "settings") return "settings";
    return profileTabs.value.find((item) => item.id === tab)?.id ?? defaultTab.value;
  },
  set: (tab) => {
    const { tab: _previous, ...query } = route.query;
    void router.replace({ query: tab === defaultTab.value ? query : { ...query, tab }, hash: route.hash });
  },
});
// A link that names a task opens the work record, where that task is shown.
// Afterwards the tabs are the person's again, though ?task= stays in the URL.
watch(() => route.query.task, (task) => {
  if (typeof task === "string" && task && activeTab.value !== "overview") activeTab.value = "overview";
}, { immediate: true });
const settingsOpen = computed(() => activeTab.value === "settings");
function toggleSettings() { activeTab.value = settingsOpen.value ? defaultTab.value : "settings"; }
// Scrolling the work down folds the header to one row; back at the top it opens.
const compactHeader = ref(false);
const headerSide = ref<HTMLElement>();
const workColumn = ref<HTMLElement>();
function onWorkScroll(event: Event) {
  const work = event.target as HTMLElement;
  compactHeader.value = headerFolds(compactHeader.value, {
    scrollTop: work.scrollTop,
    room: work.scrollHeight - work.clientHeight,
    headerHeight: headerSide.value?.offsetHeight ?? 0,
  });
}
watch(activeTab, () => { compactHeader.value = false; });
// The shell's one H1 is this Agent's real name; the route title is only the
// fallback while it loads or when the Agent is unavailable.
// The header shows the name, where the person can rename the Agent.
usePageTitle(() => (agent.value ? agentDisplayName(agent.value) : ""), { inPage: true });
// A link may use an Agent's earlier id; the page settles on its current one.
watch(agent, (person) => {
  if (person && person.agentId !== routeAgentId.value)
    void router.replace({ path: agentProfilePath(space.value, person.agentId), query: route.query, hash: route.hash });
});
// The crumb names the list that opened this page and goes Back to it, restoring
// its filters, scroll and focused card.
const openedFromOrchestration = /^\/project-agents\/manage(\?|$)/;
const openedFromDirectory = /^\/project-agents(\?|$)/;
const previousPage = (router.options.history.state as { back?: unknown } | null)?.back;
const parentCrumb = typeof previousPage === "string" && openedFromOrchestration.test(previousPage)
  ? { label: t("shell.sections.orchestrate"), to: "/project-agents/manage", from: openedFromOrchestration }
  : { label: t("agentProfiles.back"), to: "/project-agents", from: openedFromDirectory };
const collaborators = computed(() =>
  agent.value ? collaboratorsFor(agent.value.agentId, tasks.value) : [],
);
// The closest collaborator's name, for the pair phrasing below.
const collaboratorRecords = useAgentRecords(
  space,
  computed(() => collaborators.value.slice(0, 1).map((person) => person.agentId)),
);
// The pair phrasing names an FLA this one has worked with, when one is known.
const partner = computed(() => agent.value
  ? mentionPartner(agent.value, collaborators.value.flatMap((person) => collaboratorRecords.records.value[person.agentId] ?? []))
  : null);
const currentProjects = computed(() =>
  agent.value
    ? profileProjectIds({
        ...agent.value,
        assignments: assignments.value ?? agent.value.assignments,
      })
    : [],
);
const conversationProjects = computed(() =>
  projects.value
    .filter((item) => currentProjects.value.includes(item.project_id))
    .map((item) => ({ id: item.project_id, name: item.profile.name })),
);
const visibleCurrentProjects = computed(() => currentProjects.value.slice(0, 4));
const remainingCurrentProjects = computed(() => currentProjects.value.slice(4));
const previousProjects = computed(() =>
  (assignments.value ?? []).filter((item) => item.status !== "active"),
);
// Main role first, then tags; each chip opens the duties from the catalog.
const occupationKeys = computed(() => {
  const occupation = agent.value?.occupation;
  if (!occupation) return [];
  return [...new Set([...(occupation.role ? [occupation.role] : []), ...occupation.tags])];
});
useOccupationCatalog(computed(() => agent.value?.personalSpaceId ?? ""));
const date = (value?: string | null) =>
  value && !Number.isNaN(Date.parse(value))
    ? new Date(value).toLocaleDateString()
    : t("agentProfiles.timeUnknown");
const projectResponsibility = (projectId: string) => {
  const responsibility = assignments.value
    ?.find(
      (item) =>
        item.personalProjectId === projectId && item.status === "active",
    )
    ?.responsibility?.trim();
  const profileResponsibility = agent.value?.profile.responsibility.trim();
  return responsibility && responsibility !== profileResponsibility
    ? responsibility
    : "";
};
const projectOverflowLabel = computed(() => {
  const key = "agentRedesign.projects.more";
  const translated = t(key, { count: currentProjects.value.length });
  return translated === key
    ? `All projects (${currentProjects.value.length})`
    : translated;
});

let generation = 0;
watch(
  () =>
    agent.value ? `${agent.value.personalSpaceId}/${agent.value.agentId}` : "",
  async () => {
    const person = agent.value;
    const current = ++generation;
    tasks.value = [];
    workflows.value = [];
    assignments.value = undefined;
    partial.value = false;
    detailsLoading.value = false;
    if (!person) return;
    detailsLoading.value = true;
    assignments.value = person.assignments;
    const params = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
      agentId: person.agentId,
    });
    const assignmentParams = new URLSearchParams({
      personalSpaceId: person.personalSpaceId,
      agentId: person.agentId,
    });
    const assignmentRead = Promise.allSettled([
      getJson<unknown>(`/api/project-agent-assignments?${assignmentParams}`),
    ]);
    // A built-in role opens on its Workbench, which reads its own work: nothing here waits or competes with it.
    const builtIn = Boolean(employeeTemplateIdForAgent(person));
    const [taskResult, workflowResult] = await Promise.allSettled(builtIn ? [Promise.resolve([]), Promise.resolve([])] : [
      getJson<unknown>(`/api/project-agent-tasks?${params}&limit=200`),
      readAgentWorkflows(person.personalSpaceId, person.agentId),
    ]);
    if (current !== generation) return;
    if (taskResult.status === "fulfilled") {
      const value = taskResult.value;
      const record = unknownRecord(value);
      partial.value = !isAgentTaskDataComplete(value);
      tasks.value = arrayOf(
        Array.isArray(value) ? value : (record.tasks ?? record.items),
      )
        .map(normalizeTask)
        .filter((item): item is ProjectAgentTaskRecord =>
          Boolean(
            item &&
              (!item.personalSpaceId ||
                item.personalSpaceId === person.personalSpaceId) &&
              taskHasAgent(item, person.agentId),
          ),
        )
        .sort((a, b) =>
          (b.updatedAt ?? b.createdAt ?? "").localeCompare(
            a.updatedAt ?? a.createdAt ?? "",
          ),
        );
    } else partial.value = true;
    if (workflowResult.status === "fulfilled") workflows.value = workflowResult.value;
    else partial.value = true;
    const [assignmentResult] = await assignmentRead;
    if (current !== generation) return;
    if (assignmentResult.status === "fulfilled") {
      const value = assignmentResult.value;
      const record = unknownRecord(value);
      assignments.value = arrayOf(
        Array.isArray(value) ? value : (record.assignments ?? record.items),
      )
        .map((item) => normalizeAssignment(item, person))
        .filter((item): item is ProjectAgentAssignmentRecord =>
          Boolean(
            item &&
              item.agentId === person.agentId &&
              item.personalSpaceId === person.personalSpaceId,
          ),
        );
    } else partial.value = true;
    detailsLoading.value = false;
  },
  { immediate: true },
);

// After the person's decision on a workflow, its current state.
async function reloadWorkflows() {
  const person = agent.value;
  if (!person) return;
  const current = generation;
  const next = await readAgentWorkflows(person.personalSpaceId, person.agentId).catch(() => null);
  if (current === generation && next) workflows.value = next;
}

function saved(person: ProjectAgentRecord) {
  if (agent.value) self.put(routeAgentId.value, { ...agent.value, ...person });
}

onMounted(() => {
  if (store.runtimeStatus === "idle") void store.refresh();
});
// The top bar's 刷新 reads this Agent and its workflows again.
usePageRefresh(() => Promise.all([load(), reloadWorkflows()]));
</script>

<template>
  <section
    class="view agent-profile-page"
    :aria-label="agent ? agentDisplayName(agent) : t('agentProfiles.profile')"
  >
    <div class="@container grid w-full gap-4">
      <Breadcrumb :parent="parentCrumb" :current="agent ? agentDisplayName(agent) : undefined" />

      <GrowthLoading
        v-if="(loading || store.runtimeStatus === 'loading') && !agent"
        :label="t('agentProfiles.loading')"
      />
      <div
        v-else-if="(error || store.runtimeStatus === 'error') && !agent"
        class="ui-card ui-empty agent-profile-empty"
        role="alert"
      >
        <p>{{ error || t("agentProfiles.loadError") }}</p>
        <Button size="sm" variant="outline" @click="store.state ? load() : store.refresh()">
          {{ t("agentProfiles.retry") }}
        </Button>
      </div>
      <p v-else-if="!agent" class="ui-card ui-empty agent-profile-empty">
        {{ t("agentProfiles.unavailable") }}
      </p>
      <div v-else class="agent-profile-layout">
        <!-- Who this FLA is, in one row across the page; its work scrolls below. -->
        <div ref="headerSide" class="agent-profile-side" :class="{ 'is-compact': compactHeader }">
          <!-- The header carries the page's H1: the name, renamed where it stands,
               beside the portrait the person can change. -->
          <Card as="header" class="agent-resume-header">
            <span class="agent-portrait agent-identity" :style="agentIdentityStyle(agent.agentId)">
              <AgentAvatarPicker :agent-id="agent.agentId" :space-id="agent.personalSpaceId" :name="agentDisplayName(agent)" />
            </span>
            <div class="agent-resume-intro grid min-w-0 gap-1">
              <div class="agent-resume-title">
                <AgentNameEditor :agent="agent" @saved="saved" />
                <AgentHeaderTags :agent="agent" :occupation-keys="occupationKeys" />
                <!-- Folded, the description moves up beside the tags; it is read once, from the line below. -->
                <p class="agent-resume-inline-summary" aria-hidden="true" :title="agentResponsibility(agent)" data-profile-inline-summary>{{ agentResponsibility(agent) }}</p>
              </div>
              <div class="agent-resume-more">
                <div>
                  <p class="agent-resume-summary" :title="agentResponsibility(agent)">{{ agentResponsibility(agent) }}</p>
                  <div class="agent-resume-meta">
                    <span>
                      {{ t(agent.recruitedAt ? "agentProfiles.joined" : "agentProfiles.created") }}
                      · {{ date(agent.recruitedAt || agent.createdAt) }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div class="agent-profile-actions">
              <AgentMentionCopy v-if="mentionKind(agent)" :kind="mentionKind(agent)" size="default" :name="agentDisplayName(agent)" :partner="partner" />
              <Button variant="outline" :aria-expanded="settingsOpen" data-profile-settings @click="toggleSettings">
                {{ t("agentProfiles.settings") }}
              </Button>
            </div>
          </Card>

          <AgentRenameHint :agent="agent" @saved="saved" />
        </div>
        <div ref="workColumn" class="agent-profile-main" @scroll.passive="onWorkScroll">
          <PageOutline :content="workColumn" />

          <GrowthLoading
            v-if="loading || store.runtimeStatus === 'loading'"
            variant="compact"
            :label="t('agentProfiles.loading')"
          />
          <p v-if="error" class="agent-profile-refresh-status" role="status">
            {{ error }}
          </p>

          <Tabs v-model="activeTab" :unmount-on-hide="false" class="agent-profile-tabs min-w-0">
            <TabsList v-if="profileTabs.length > 1" :aria-label="agentDisplayName(agent)">
              <TabsTrigger v-for="tab in profileTabs" :key="tab.id" :value="tab.id" :data-profile-tab="tab.id">
                {{ tab.label }}
              </TabsTrigger>
            </TabsList>

            <GrowthLoading
              v-if="detailsLoading"
              variant="compact"
              :label="t('agentProfiles.detailLoading')"
            />
            <p v-if="partial" class="agent-profile-partial" role="status">
              {{ t("agentProfiles.partial") }}
            </p>

            <TabsContent v-if="hasWorkbench" value="workbench" class="agent-profile-panel" data-profile-panel="workbench">
              <!-- Mounted only while open, so its board and drag handlers leave with the tab. -->
              <EmployeeWorkbench v-if="activeTab === 'workbench' && employeeId" :key="employeeId" :template-id="employeeId" />
            </TabsContent>

            <TabsContent value="overview" class="agent-profile-panel" data-profile-panel="overview">
              <div class="agent-profile-history-grid">
                <!-- What sits here is the layout's call (widgets/layout.ts): by default this FLA's task sheets (rec#11 D-82). -->
                <WidgetSlot place="fla.overview"
                  :context="{ spaceId: agent.personalSpaceId, agentId: agent.agentId, agentName: agentDisplayName(agent), projectName }" />

                <Card as="section" class="agent-resume-section agent-projects-section" aria-labelledby="agent-projects-heading">
                  <div class="agent-section-heading">
                    <h2 id="agent-projects-heading">{{ t("agentProfiles.projects") }}</h2>
                    <span>{{ currentProjects.length }}</span>
                  </div>
                  <ul class="agent-resume-list agent-current-project-list">
                    <li v-for="id in visibleCurrentProjects" :key="id" class="agent-project-item">
                      <h3>
                        <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">
                          {{ projectName(id) }}
                        </RouterLink>
                      </h3>
                      <p v-if="projectResponsibility(id)" class="agent-project-responsibility">
                        {{ projectResponsibility(id) }}
                      </p>
                    </li>
                  </ul>
                  <UiDisclosure
                    v-if="remainingCurrentProjects.length"
                    class="agent-project-overflow"
                    :title="projectOverflowLabel"
                  >
                    <ul class="agent-resume-list">
                      <li v-for="id in remainingCurrentProjects" :key="id" class="agent-project-item">
                        <h3>
                          <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', id)">
                            {{ projectName(id) }}
                          </RouterLink>
                        </h3>
                        <p v-if="projectResponsibility(id)" class="agent-project-responsibility">
                          {{ projectResponsibility(id) }}
                        </p>
                      </li>
                    </ul>
                  </UiDisclosure>
                  <p v-if="!detailsLoading && !currentProjects.length" class="agent-muted">
                    {{ t("agentProfiles.noProject") }}
                  </p>
                </Card>
                <Card v-if="hasWorkflows" as="section" class="agent-resume-section">
                  <AgentWorkflowList :workflows="workflows" @changed="reloadWorkflows" />
                </Card>
                <AgentManagement v-if="activeTab === 'overview'" :key="`work-${agent.agentId}`" :space-id="agent.personalSpaceId" :agent-id="agent.agentId" :sections="['activity', 'work']" finished-only />

                <Card v-if="previousProjects.length || agent.archiveReason || agent.recruitedAt || agent.recruitmentReason" as="section" class="agent-resume-section" aria-labelledby="agent-history-record-heading">
                  <h2 id="agent-history-record-heading">{{ t("agentProfiles.projectHistory") }}</h2>
                  <ol class="agent-work-timeline">
                    <li v-if="agent.archiveReason" data-profile-departure>
                      <h3>{{ t("agentProfiles.departure") }}</h3>
                      <p>{{ agent.archiveReason }}</p>
                      <small>{{ date(agent.archivedAt) }}</small>
                    </li>
                    <li v-for="item in previousProjects" :key="item.assignmentId">
                      <h3>
                        <RouterLink class="agent-project-link" :to="personalProjectsPath(space, 'overview', item.personalProjectId)">
                          {{ projectName(item.personalProjectId) }}
                        </RouterLink>
                      </h3>
                      <p>{{ item.responsibility }}</p>
                      <small>{{ date(item.assignedAt) }} – {{ date(item.endedAt) }}</small>
                    </li>
                    <li v-if="agent.recruitedAt || agent.recruitmentReason">
                      <h3>{{ t("agentProfiles.recruitment") }}</h3>
                      <p v-if="agent.recruitmentReason">{{ agent.recruitmentReason }}</p>
                      <small>{{ date(agent.recruitedAt) }}</small>
                    </li>
                  </ol>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="settings" class="agent-profile-panel" data-profile-panel="settings">
              <div v-if="settingsOpen" class="agent-profile-history-grid">
                <AgentProfileSettings :key="agent.agentId" :agent="agent" @saved="saved" />
                <AgentOccupationEditor v-if="agent.profile.status !== 'archived'" :key="`occupation-${agent.agentId}`" :agent="agent" @saved="saved" />
                <Card v-if="agent.memoryScope === 'reviewed_agent'" as="section" class="agent-resume-section" aria-labelledby="agent-memory-settings-heading">
                  <h2 id="agent-memory-settings-heading">{{ t("agentProfiles.memorySettings") }}</h2>
                  <AgentConversations :key="agent.agentId" :personal-space-id="space" :agent-id="agent.agentId" :projects="conversationProjects" />
                  <EmployeeWorkHistory :personal-space-id="space" :agent-id="agent.agentId" :projects="conversationProjects" />
                </Card>
                <AgentManagement :key="`manage-${agent.agentId}`" :space-id="agent.personalSpaceId" :agent-id="agent.agentId" :sections="['projects', 'recruitment', 'execution']" />
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  </section>
</template>

<style src="@/features/agent-profile/agent-profile.css" />

<style scoped>
.agent-portrait.agent-identity {
  color: var(--agent-identity, var(--color-accent));
  background: var(--agent-identity-soft, var(--color-accent-soft));
}

.agent-portrait.agent-identity:has(img) {
  box-shadow: 0 0 0 2px var(--agent-identity, transparent);
}
/* Panels stack in one column at every width (rec#38). */
.agent-profile-history-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
/* One column at every width (Jevons 11-04): who this FLA is runs across the top
   and only its work below scrolls, so the page never does at the client's
   default 1280px window. Narrower windows let the page scroll as before. */
.agent-profile-layout { display: grid; gap: var(--space-4, 16px); min-width: 0; }
.agent-profile-side, .agent-profile-main { display: grid; align-content: start; gap: var(--space-4, 16px); min-width: 0; }
/* The tabs fill the column, so a workbench can fill the tab. */
.agent-profile-tabs [data-profile-panel="workbench"][data-state="active"] { display: flex; flex: 1; flex-direction: column; min-height: 0; }

@media (min-width: 1100px) {
  .agent-profile-page { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 20px !important; }
  .agent-profile-page > .grid { flex: 1; grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
  .agent-profile-layout { grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
  /* The column clears the floating dock itself, since the page no longer scrolls. */
  .agent-profile-main { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding-bottom: var(--dock-clearance); }
  .agent-profile-main > .agent-profile-tabs { flex: 1 0 auto; }
}
</style>
