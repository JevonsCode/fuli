<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import AgentAvatarPicker from "@/features/agent-profile/AgentAvatarPicker.vue";
import AgentNameEditor from "@/features/agent-profile/AgentNameEditor.vue";
import { agentIdentityStyle } from "@/features/agent-profile/agent-identity-color";
import { computed, defineAsyncComponent, defineComponent, h, nextTick, onMounted, ref, watch, type Component } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getJson } from "@/api/client";
import { useConsoleStore } from "@/stores/console";
import { t } from "@/i18n";
import Breadcrumb from "@/components/Breadcrumb.vue";
import PageOutline from "@/components/PageOutline.vue";
import PageStack from "@/components/PageStack.vue";
import GrowthLoading from "@/components/GrowthLoading.vue";
import AgentProfileSettings from "@/features/agent-profile/AgentProfileSettings.vue";
import AgentOccupationEditor from "@/features/agent-profile/AgentOccupationEditor.vue";
import { useOccupationCatalog } from "@/features/occupations/occupation-catalog";
import OccupationChip from "@/features/occupations/OccupationChip.vue";
import AgentConversations from "@/features/project-agents/AgentConversations.vue";
import EmployeeWorkHistory from "@/features/project-agents/EmployeeWorkHistory.vue";
import WidgetSlot from "@/widgets/WidgetSlot.vue";
import {
  agentDisplayName,
  agentProfilePath,
  collaboratorsFor,
  mentionPartner,
  profileProjectIds,
} from "@/features/agent-profile/profile-model";
import AgentRenameHint from "@/features/agent-profile/AgentRenameHint.vue";
import { mentionKind } from "@/features/agent-profile/fla-mention";
import { isAgentTaskDataComplete, summarizeAgentTasks, taskHasAgent } from "@/features/agent-profile/agent-work-summary";
import { agentWorkbenchEntry, indexWorkbenchTasks } from "@/features/agent-profile/agent-workbench";
import { useAgentRecords } from "@/features/agent-profile/useAgentRecords";
import { useNow } from "@/composables/useNow";
import FlaAttention from "@/features/fla-page/FlaAttention.vue";
import FlaHandOff from "@/features/fla-page/FlaHandOff.vue";
import FlaNow from "@/features/fla-page/FlaNow.vue";
import FlaRecentWork from "@/features/fla-page/FlaRecentWork.vue";
import FlaResponsibility from "@/features/fla-page/FlaResponsibility.vue";
import { useAgentGrowth } from "@/features/fla-page/agent-growth";
import { useAgentSheets } from "@/features/fla-page/agent-sheets";
import { useFlaKit } from "@/features/fla-page/kit-read";
import { finishedWork, nowLine } from "@/features/fla-page/fla-now";
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
import { usePageTitle } from "@/layouts/page-title";
import { openWorkflows, readAgentWorkflows, type AgentWorkflow } from "@/features/agent-workbench/agent-workflows";
import AgentWorkflowList from "@/features/agent-workbench/AgentWorkflowList.vue";
import { usePageRefresh } from "@/layouts/page-refresh";
import { pickerOrder, hasTemporaryOrigin, projectDisplayName } from '@/features/projects/project-origin'

// The Workbench and the management sections load only when they are shown (rec#60 D-78).
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
const projectName = (id: string) => {
  const project = projects.value.find((item) => item.project_id === id);
  return (project && projectDisplayName(project)) || id;
};

const tasks = ref<ProjectAgentTaskRecord[]>([]);
// The task page as read: 现在 summarises it the way the FLAs list does.
const taskPage = ref<unknown>(null);
const taskRead = ref<"loading" | "ready" | "incomplete" | "error">("loading");
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
// A link that names a task opens that task at the top of the column.
// Afterwards the tabs are the person's again, though ?task= stays in the URL.
const linkedTask = computed(() => typeof route.query.task === "string" && route.query.task ? route.query.task : "");
watch(linkedTask, (task) => {
  if (task && activeTab.value !== "overview") activeTab.value = "overview";
}, { immediate: true });
const settingsOpen = computed(() => activeTab.value === "settings");
function toggleSettings() { activeTab.value = settingsOpen.value ? defaultTab.value : "settings"; }
const workColumn = ref<HTMLElement>();
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
const conversationProjectRecords = computed(() => projects.value.filter((item) => currentProjects.value.includes(item.project_id)));
const conversationProjects = computed(() => pickerOrder(conversationProjectRecords.value).map((item) => ({
  id: item.project_id, name: projectDisplayName(item), temporary: hasTemporaryOrigin(item) })));
// The quiet line under the name: main occupation, the FLA number, the other tags.
const occupationKeys = computed(() => {
  const occupation = agent.value?.occupation;
  if (!occupation) return [];
  return [...new Set([...(occupation.role ? [occupation.role] : []), ...occupation.tags])];
});
useOccupationCatalog(computed(() => agent.value?.personalSpaceId ?? ""));
async function copyNumber(number: string) {
  try {
    await navigator.clipboard.writeText(`FLA ${number}`);
    store.notify(t("flaPage.identity.numberCopied", { number }));
  } catch (cause) {
    store.reportError(cause);
  }
}

// 现在: the same reading of the FLA's status the FLAs list uses, with the step
// and bar of the task it is on from its task sheets.
const agentSpace = computed(() => agent.value?.personalSpaceId ?? "");
const agentKey = computed(() => agent.value?.agentId ?? "");
const sheets = useAgentSheets(agentSpace, agentKey);
// The reads 等你处理 shares with 起步包 and 学会了, so 刷新 renews them too.
const kitRead = useFlaKit(agentSpace, agentKey);
const growthRead = useAgentGrowth(agentSpace, agentKey);
const clock = useNow();
const entry = computed(() => agent.value ? agentWorkbenchEntry(agent.value, {
  summary: summarizeAgentTasks(taskPage.value, agent.value.personalSpaceId)[agent.value.agentId],
  summaryState: taskRead.value,
  tasks: indexWorkbenchTasks(taskPage.value, agent.value.personalSpaceId),
}) : null);
const now = computed(() => agent.value && entry.value
  ? nowLine({ entry: entry.value, agentId: agent.value.agentId, sheets: sheets.sheets.value, tasks: tasks.value, now: clock.value }) : null);
const finished = computed(() => finishedWork(tasks.value));
// 等你处理 goes to the section where it is answered: on the work tab, opened.
async function reveal(sectionId: string) {
  if (activeTab.value !== "overview") activeTab.value = "overview";
  await nextTick();
  const section = document.getElementById(sectionId);
  const fold = section?.querySelector("details");
  if (fold) fold.open = true;
  section?.scrollIntoView({ block: "start" });
}

let generation = 0;
// `keep`: 刷新 reads again over what is shown, instead of emptying the page first.
async function readDetails(options: { keep?: boolean } = {}) {
  const person = agent.value;
  const current = ++generation;
  if (!options.keep) {
    tasks.value = [];
    taskPage.value = null;
    taskRead.value = "loading";
    workflows.value = [];
    assignments.value = undefined;
    partial.value = false;
  }
  detailsLoading.value = false;
  if (!person) return;
  detailsLoading.value = !options.keep;
  if (!options.keep) assignments.value = person.assignments;
  const params = new URLSearchParams({
    personalSpaceId: person.personalSpaceId,
    agentId: person.agentId,
  });
  const assignmentRead = Promise.allSettled([
    getJson<unknown>(`/api/project-agent-assignments?${params}`),
  ]);
  // A built-in role opens on its Workbench, which reads its own work: nothing here competes with it.
  // Only the task its roster names is read, so 现在 can say when that last moved; with no status
  // on the roster, 现在 says none was reported rather than 没活 from a list it never read.
  const builtIn = Boolean(employeeTemplateIdForAgent(person));
  const reported = typeof person.workStatus === "string";
  const named = builtIn && reported ? person.currentTaskId ?? null : null;
  const [taskResult, workflowResult] = await Promise.allSettled(builtIn ? [
    named ? getJson<unknown>(`/api/project-agent-tasks/${encodeURIComponent(named)}?${new URLSearchParams({ personalSpaceId: person.personalSpaceId })}`)
      .then(task => [task]) : Promise.resolve([]),
    Promise.resolve([]),
  ] : [
    getJson<unknown>(`/api/project-agent-tasks?${params}&limit=200`),
    readAgentWorkflows(person.personalSpaceId, person.agentId),
  ]);
  if (current !== generation) return;
  if (taskResult.status === "fulfilled") {
    const value = taskResult.value;
    const record = unknownRecord(value);
    partial.value = builtIn ? false : !isAgentTaskDataComplete(value);
    taskPage.value = value;
    taskRead.value = builtIn ? (reported ? "ready" : "incomplete") : partial.value ? "incomplete" : "ready";
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
  } else {
    partial.value = !builtIn;
    // A failed refresh keeps the tasks it read before.
    if (!options.keep || taskRead.value === "loading") taskRead.value = "error";
  }
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
}
watch(() => (agent.value ? `${agent.value.personalSpaceId}/${agent.value.agentId}` : ""), () => readDetails(), { immediate: true });

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
// The top bar's 刷新 reads this Agent, its tasks, workflows, task sheets, kit and growth again,
// so 现在 and 最近做完 come from the same moment.
usePageRefresh(() => Promise.all([load(), readDetails({ keep: true }), sheets.reload(), kitRead.reload(), growthRead.reload()]));
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
        <!-- Fixed: who this FLA is and what it is doing now (docs/fla-page.md). -->
        <PageStack class="agent-profile-side">
          <header class="fla-head" data-fla-head>
            <div class="fla-identity">
              <span class="agent-portrait agent-identity" :style="agentIdentityStyle(agent.agentId)">
                <AgentAvatarPicker :agent-id="agent.agentId" :space-id="agent.personalSpaceId" :name="agentDisplayName(agent)" />
              </span>
              <div class="fla-who">
                <AgentNameEditor :agent="agent" @saved="saved" />
                <p class="fla-meta" data-profile-occupation>
                  <span v-if="agent.profile.status !== 'active'" class="ui-badge agent-profile-membership" :class="`is-${agent.profile.status}`">
                    {{ t(`projectAgents.status.${agent.profile.status}`) }}
                  </span>
                  <span v-if="occupationKeys[0]" class="fla-meta-item"><OccupationChip :occupation-key="occupationKeys[0]" :main="Boolean(agent.occupation?.role)" /></span>
                  <span v-else class="fla-meta-item">{{ t("agentRedesign.occupation.notSet") }}</span>
                  <span v-if="agent.employeeNumber" class="fla-meta-item">
                    <Button variant="ghost" size="xs" class="fla-number ui-num" :title="t('flaPage.identity.copyNumber', { number: agent.employeeNumber })"
                      :aria-label="t('flaPage.identity.copyNumber', { number: agent.employeeNumber })" data-fla-number
                      @click="copyNumber(agent.employeeNumber)">FLA {{ agent.employeeNumber }}</Button>
                  </span>
                  <span v-for="key in occupationKeys.slice(1)" :key="key" class="fla-meta-item"><OccupationChip :occupation-key="key" /></span>
                  <span v-if="agent.formerName" class="fla-meta-item">{{ t("agentProfiles.name.former", { name: agent.formerName }) }}</span>
                </p>
              </div>
              <div class="agent-profile-actions">
                <FlaHandOff :space-id="agent.personalSpaceId" :agent-id="agent.agentId" :name="agentDisplayName(agent)" :partner="partner"
                  :kind="mentionKind(agent)" :tasks="tasks" :project-name="projectName" />
                <Button variant="outline" :aria-expanded="settingsOpen" data-profile-settings @click="toggleSettings">
                  {{ t("agentProfiles.settings") }}
                </Button>
              </div>
            </div>
            <div v-if="now && entry" class="fla-now">
              <FlaNow :line="now" :entry="entry" :sessions-link="!hasWorkbench" @retry="readDetails()" @sessions="reveal('fla-worked-heading')" />
              <FlaAttention :space-id="agent.personalSpaceId" :agent-id="agent.agentId" :others="'others' in now ? now.others ?? null : null" @reveal="reveal" />
            </div>
          </header>
          <AgentRenameHint :agent="agent" @saved="saved" />
        </PageStack>

        <!-- Scrolls on its own from 1100px, so 现在 stays on screen. -->
        <div ref="workColumn" class="agent-profile-main">
          <PageOutline :content="workColumn" />
          <PageStack class="fla-column">
            <p v-if="error" class="agent-profile-refresh-status" role="status">
              {{ error }}
            </p>

            <Tabs v-model="activeTab" :unmount-on-hide="false" class="agent-profile-tabs min-w-0">
              <TabsList v-if="profileTabs.length > 1" :aria-label="agentDisplayName(agent)">
                <TabsTrigger v-for="tab in profileTabs" :key="tab.id" :value="tab.id" :data-profile-tab="tab.id">
                  {{ tab.label }}
                </TabsTrigger>
              </TabsList>

              <p v-if="partial" class="agent-profile-partial" role="status">
                {{ t("agentProfiles.partial") }}
              </p>

              <TabsContent v-if="hasWorkbench" value="workbench" class="agent-profile-panel" data-profile-panel="workbench">
                <!-- Mounted only while open, so its board and drag handlers leave with the tab. -->
                <EmployeeWorkbench v-if="activeTab === 'workbench' && employeeId" :key="employeeId" :template-id="employeeId" />
              </TabsContent>

              <TabsContent value="overview" class="agent-profile-panel" data-profile-panel="overview">
                <div class="agent-profile-history-grid">
                  <!-- A link that names a task (?task=) opens that one task here, above the rest. -->
                  <AgentManagement v-if="linkedTask && activeTab === 'overview'" :key="`task-${agent.agentId}`" :space-id="agent.personalSpaceId"
                    :agent-id="agent.agentId" :sections="['work']" linked-only data-fla-linked-task />
                  <!-- The order is the layout's (widgets/layout.ts); the page's own sections sit between its places. -->
                  <WidgetSlot place="fla.overview"
                    :context="{ spaceId: agent.personalSpaceId, agentId: agent.agentId, agentName: agentDisplayName(agent), projectName }" />
                  <Card v-if="hasWorkflows" as="section" class="agent-resume-section">
                    <AgentWorkflowList :workflows="workflows" @changed="reloadWorkflows" />
                  </Card>
                  <FlaRecentWork :work="finished" :project-name="projectName" />
                  <WidgetSlot place="fla.history"
                    :context="{ spaceId: agent.personalSpaceId, agentId: agent.agentId, agentName: agentDisplayName(agent), projectName }" />
                  <FlaResponsibility :agent="agent" :assignments="assignments" :loading="detailsLoading" :project-name="projectName" />
                  <WidgetSlot place="fla.profile"
                    :context="{ spaceId: agent.personalSpaceId, agentId: agent.agentId, agentName: agentDisplayName(agent), projectName }" />
                </div>
              </TabsContent>

              <TabsContent value="settings" class="agent-profile-panel" data-profile-panel="settings">
                <div v-if="settingsOpen" class="agent-profile-history-grid">
                  <AgentProfileSettings :key="agent.agentId" :agent="agent" @saved="saved" />
                  <AgentOccupationEditor v-if="agent.profile.status !== 'archived'" :key="`occupation-${agent.agentId}`" :agent="agent" @saved="saved" />
                  <Card v-if="agent.memoryScope === 'reviewed_agent'" as="section" class="agent-resume-section" aria-labelledby="agent-memory-settings-heading">
                    <h2 id="agent-memory-settings-heading">{{ t("agentProfiles.memorySettings") }}</h2>
                    <AgentConversations :key="agent.agentId" :personal-space-id="space" :agent-id="agent.agentId" :projects="conversationProjectRecords" />
                    <EmployeeWorkHistory :personal-space-id="space" :agent-id="agent.agentId" :projects="conversationProjects" />
                  </Card>
                  <AgentManagement :key="`manage-${agent.agentId}`" :space-id="agent.personalSpaceId" :agent-id="agent.agentId" :sections="['projects', 'recruitment', 'execution']" />
                </div>
              </TabsContent>
            </Tabs>
          </PageStack>
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
/* The fixed region: one surface, identity then 现在 under a hairline. No card inside a card. */
.fla-head { display: grid; border-radius: var(--radius-card); background: var(--color-surface); box-shadow: 0 0 0 1px var(--color-border); }
.fla-identity { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 16px 20px; }
/* 44px: the portrait identifies; it is not the subject. */
.fla-identity .agent-portrait { width: 44px; height: 44px; flex-basis: 44px; border-radius: 13px; font-size: 22px; }
.fla-who { display: grid; gap: 2px; min-width: 0; }
.fla-who :deep([data-agent-name]) { font-size: var(--text-title); }
.fla-meta { display: flex; flex-wrap: wrap; align-items: center; margin: 0; color: var(--color-muted); font-size: var(--text-meta); }
.fla-meta-item { display: inline-flex; align-items: center; }
.fla-meta-item + .fla-meta-item::before { content: '·'; margin-inline: 6px; color: var(--color-faint); }
.fla-meta .agent-profile-membership { margin-right: 8px; }
/* The occupation names read as words in the line; a click still opens their duties. */
.fla-meta :deep(.occupation-chip) { height: auto; padding: 0; border: 0; color: inherit; background: none; font: inherit; }
.fla-meta :deep(.occupation-chip:hover) { color: var(--color-ink); text-decoration: underline; }
.fla-number { min-height: 0; margin-inline: -4px; padding: 1px 4px; color: inherit; font: inherit; cursor: copy; }
.fla-meta :deep(.occupation-chip:focus-visible) { outline: 2px solid var(--color-focus); outline-offset: 2px; border-radius: 4px; }
.fla-now { display: grid; gap: 4px; padding: 12px 20px; border-top: 1px solid var(--color-border); }
/* Panels stack in one column at every width (rec#38). */
.agent-profile-history-grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-4); }
/* One column at every width (Jevons 11-04): who this FLA is runs across the top
   and only its work below scrolls, so the page never does at the client's
   default 1280px window. Narrower windows let the page scroll as before. */
.agent-profile-layout { display: grid; gap: var(--space-4, 16px); min-width: 0; }
.agent-profile-side, .agent-profile-main { min-width: 0; }
/* The tabs fill the column, so a workbench can fill the tab. */
.agent-profile-tabs [data-profile-panel="workbench"][data-state="active"] { display: flex; flex: 1; flex-direction: column; min-height: 0; }

/* Below 860px the identity row stacks: portrait and name, the meta line, then the actions full width. */
@media (max-width: 859px) {
  .fla-identity { grid-template-columns: auto minmax(0, 1fr); padding: 12px 16px; }
  .fla-identity .agent-profile-actions { grid-column: 1 / -1; justify-content: stretch; }
  .fla-identity .agent-profile-actions > * { flex: 1 1 0; }
  .fla-now { padding: 10px 16px; }
}

@media (min-width: 1100px) {
  .agent-profile-page { display: flex; flex-direction: column; overflow: hidden; padding-bottom: 20px !important; }
  .agent-profile-page > .grid { flex: 1; grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
  .agent-profile-layout { grid-template-rows: auto minmax(0, 1fr); min-height: 0; }
  /* The column clears the floating dock itself, since the page no longer scrolls. */
  .agent-profile-main { display: flex; flex-direction: column; min-height: 0; overflow-y: auto; padding-bottom: var(--dock-clearance); }
  .agent-profile-main > .fla-column { flex: 1 0 auto; }
  /* A built-in role's Workbench fills what the column leaves under the tabs. */
  .fla-column > .agent-profile-tabs { flex: 1 1 auto; min-height: 0; }
}
</style>
