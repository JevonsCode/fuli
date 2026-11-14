import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmployeeService } from '../employees/service.js';
import { createAppConsoleActions } from '../agent-apps/console-actions.js';
import { agentAppRoot, createAgentAppService } from '../agent-apps/service.js';
import { revealPath } from '../desktop/reveal-path.js';
import { openTerminalWindow } from '../desktop/terminal-window.js';
import { createAgentServices } from '../agent-services/port.js';
import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { createAgentRoundtable } from '../../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../../packages/roundtable/src/roundtable/store.js';
import { createDesktopApps } from '../../packages/roundtable/src/agents/desktop-registry.js';
import { createPeerPort } from '../../packages/roundtable/src/peer/peer-port.js';
import { createFuliRoundtableHost } from './roundtable-host.js';
import { attachJudgmentRuntime } from '../judgment/runtime.js';
import {
  openModelBackendRuntime,
  openRoleSuggestionLog,
  openRoleTrustAndHistory
} from '../model-backends/runtime.js';
import { createStandingAssignments } from '../standing-assignments/port.js';
import { createAgentWorkflows } from '../agent-workflows/port.js';
import { RecallImpressionsStore } from '../knowledge-impressions/store.js';
import { DELEGATION_LOG_FILE, DelegatedOperationLog } from '../agent-delegation/operation-log.js';
import { createAgentAvatars } from '../agent-avatars/port.js';
import { createProjectChangeLog } from '../project-change-log/port.js';
import { createPersonProfile } from '../person-profile/port.js';
import { createProjectOrganizing } from '../project-organizing/port.js';
import { isLoopbackUrl } from '../external-knowledge/connectors/response-values.js';
import { entryPromptRecords } from '../agent-delegation/entry-prompts.js';
import { createWorkSurfaces } from '../work-surfaces/port.js';
import { createVisitorAccess } from '../visitor-access/port.js';
import { createVisitRequests } from '../visit-requests/service.js';
import { createVisitRunner } from '../visit-requests/runner.js';
import { CONSTRAINED_RUN_CLIENTS, runConstrained } from '../../packages/roundtable/src/roundtable/constrained-run.js';
import { fuliMcpServerEntry } from '../agent-kits/fuli-mcp-entry.js';
import { createOldDataShelf } from '../old-data/port.js';
import { createOccupationPlugins } from '../occupation-plugins/port.js';
import { workSurfaceNames, workSurfaceSources } from '../work-surfaces/sources.js';
import { createAgentDirectorySnapshots } from '../agents/directory-snapshots.js';
import { attachExternalKnowledgeRuntime } from '../external-knowledge/runtime.js';
import { createSessionPreferenceDelivery } from '../conversations/preference-session.js';
import { createSessionPromptSentences } from './session-prompt-sentences.js';
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { nativeChoiceAnswers } from '../agents/choice-answers.js';
import { createProcessInspector } from '../agent-services/process-identity.js';

// The local stores and runtimes an application opened from a runtime
// directory owns. Adding one means opening it here and closing it below.
export function openLocalRuntimes(app, { runtimeConfigPath, paths, env, fetchImpl }) {
  const dataDir = dirname(runtimeConfigPath);
  const providerIdentity = app.config.personal.providerUrl;
  // The runtime failures this process and the data directory's other FULI processes caught (rec#73).
  app.diagnosticEvents = diagnosticEventLog(dataDir);
  app.preferenceDelivery = createSessionPreferenceDelivery({
    directory: join(dataDir, 'preference-delivery'),
    env
  });
  // The sentence keys of each session's earlier prompts, for the entry recall (rec#88).
  app.sessionPromptSentences = createSessionPromptSentences({ dataDir });
  attachExternalKnowledgeRuntime(app, { paths, env, fetchImpl });
  app.agentSnapshots = createAgentDirectorySnapshots({
    root: paths.agentDirectoryRoot,
    providerIdentity
  });
  app.employees = createEmployeeService({ app, runtimeConfigPath });
  // The services FULI Agents started (服务管理): workbenches recorded by the
  // app runner below, other servers reported by their Agents.
  app.agentServices = createAgentServices({
    path: join(dataDir, 'agent-services.sqlite'),
    stopWorkbench: (appId) => app.agentApps.stop({ appId })
  });
  app.agentApps = createAgentAppService({
    root: agentAppRoot(runtimeConfigPath),
    providerIdentity,
    resolveOwner: (owner) => app.getProjectAgent(owner),
    toolNames: () => listAgentTools().map(({ name }) => name),
    ownerKind: 'console',
    serviceLog: app.agentServices.workbench,
    callFuliTool: (name, input) => callAgentTool(app, name, input)
  });
  // The console's Apps buttons that open a terminal confirmation or export data (#346).
  app.agentAppConsole = createAppConsoleActions({
    agentApps: app.agentApps,
    cli: [process.execPath, fileURLToPath(new URL('../cli.js', import.meta.url))],
    runtimeConfigPath,
    exportsRoot: join(homedir(), 'Downloads', 'FULI app exports'),
    openTerminal: openTerminalWindow,
    reveal: revealPath
  });
  // A built-in embedding model runs in the local graph service (src/embedding-models).
  // Only a graph service on this computer: one elsewhere would receive the texts, and the
  // built-in protocol asks for no project approval because nothing is meant to leave.
  app.modelBackends = openModelBackendRuntime(paths, {
    builtinEmbed: isLoopbackUrl(providerIdentity) ? input => app.personal.builtinEmbed(input) : null });
  ({ trust: app.modelTrust, history: app.modelSettingsHistory } = openRoleTrustAndHistory(paths, app.modelBackends));
  attachJudgmentRuntime(app, paths);
  app.roleSuggestions = openRoleSuggestionLog(paths, { recoveryGate: app.knowledgeRecoveryGate });
  // Opens its file on the first registration; reads before that find none.
  app.standingAssignments = createStandingAssignments({ path: paths.standingAssignmentsPath });
  // Each Agent's own workflows (rec#60 D-78); the file is created by the first proposal.
  app.agentWorkflows = createAgentWorkflows({ path: join(dataDir, 'agent-workflows.sqlite') });
  // Which knowledge the automatic recall showed and which the Agent reported using (rec#63); recall reads it as a ranking prior.
  app.recallImpressions = new RecallImpressionsStore(join(dataDir, 'recall-impressions.sqlite'));
  // Read here only for the compounding statement's count of changes made for the person;
  // the console's delegation port alone records them. A missing file reads as none.
  app.delegatedOperations = new DelegatedOperationLog(join(dataDir, DELEGATION_LOG_FILE));
  // Each Agent's look as the person chose it (rec#11 D-89); the file is created by the first choice.
  app.agentAvatars = createAgentAvatars({ path: join(dataDir, 'agent-avatars.sqlite') });
  // What visitors from other computers read of a shared project, and each requester's mode; created by the first one.
  app.visitorAccess = createVisitorAccess({ path: join(dataDir, 'visitor-access.sqlite'), application: app,
    // Work a paired computer asks to have done here (seconding C): plain constrained client runs, as the shared lead, in its own worktree.
    requests: ({ store, modeOf }) => createVisitRequests({ store, modeOf, runner: createVisitRunner({
      runClient: (input) => runConstrained({ ...input, env }),
      projectFolder: (input) => app.roundtable.knownProjectFolder(input),
      verifyFolder: async (folder, projectId) => await app.roundtableHost.projectForPath(folder) === projectId,
      root: join(dataDir, 'visit-worktrees') }),
    leads: {
      confirm: async ({ projectId, agentId }) => await app.roundtableHost.projectLeadId(projectId) === agentId,
      constrainedClients: async ({ agentId }) => (await app.roundtable.visitClients({ agentId }))
        .filter((client) => CONSTRAINED_RUN_CLIENTS.includes(client)),
      describe: async ({ projectId, agentId }) => {
        const { lead } = await app.roundtableHost.projectTeam(projectId);
        return lead?.agentId === agentId ? { name: lead.name, responsibility: lead.responsibility ?? null } : null;
      }
    } }) });
  // FULI's own MCP server as the installer writes it for a client: a session woken on another
  // computer's text loads only this one (packages/roundtable deliver).
  app.fuliMcpServer = (client) => {
    try { return fuliMcpServerEntry({ paths, runtimeConfigPath, client }); } catch { return null; }
  };
  // What changed in each project's profile; the file is created by the first change.
  app.projectChangeLog = createProjectChangeLog({ path: join(dataDir, 'project-change-log.sqlite') });
  // The person's own name and picture (「我」); the file is created by the first change.
  app.personProfile = createPersonProfile({ path: join(dataDir, 'person-profile.json') });
  // How well each project is known and what each 整理 run did (rec#114); created by the first run.
  app.projectOrganizing = createProjectOrganizing({ path: join(dataDir, 'project-organizing.json') });
  // The prompt of each session's current hook-entered task, kept only for the relay check (rec#80).
  app.entryPrompts = entryPromptRecords(dataDir);
  // What the person answered in the client's own question card, for the same check.
  app.nativeChoiceAnswers = task => nativeChoiceAnswers(task, { env });
  // Every FLA's work surfaces in one table, with 全部暂停 and 恢复 (rec#11 D-85); the file is created by the first pause.
  app.workSurfaces = createWorkSurfaces({ path: join(dataDir, 'work-surfaces.sqlite'), sources: workSurfaceSources(app),
    names: (personalSpaceId) => workSurfaceNames(app, personalSpaceId) });
  // The copies FULI keeps before it changes something (旧数据, rec#80 group B); reads only.
  app.oldData = createOldDataShelf({ paths });
  // Each occupation's starter kit and what the person enabled per FLA; the choices file is created by the first answer.
  app.occupationPlugins = createOccupationPlugins({ statePath: join(dataDir, 'occupation-plugins.json'),
    choicesPath: join(dataDir, 'occupation-kit-choices.sqlite'), fetchImpl });
  app.roundtableHost = createFuliRoundtableHost(app);
  app.peer = createPeerPort({ dataDir, host: app.roundtableHost });
  app.roundtable = createAgentRoundtable({
    host: app.roundtableHost,
    peer: app.peer,
    env,
    // Asks to a Codex FLA go to its inbox conversation in the Codex app when that app is installed.
    desktopApp: createDesktopApps({ env }),
    openStore: () => createRoundtableStore(join(dataDir, 'agent-roundtable.sqlite')),
    // A wake claim its console lost is released only once its process has ended.
    inspectProcess: createProcessInspector().inspect
  });
}

// An application that only lives in memory opened none of them.
export function closeLocalRuntimes(app) {
  app.judgment?.close();
  app.standingAssignments?.close();
  app.agentWorkflows?.close();
  app.recallImpressions?.close();
  app.delegatedOperations?.close();
  app.agentAvatars?.close();
  app.visitorAccess?.close();
  app.occupationPlugins?.close();
  app.projectChangeLog?.close();
  app.workSurfaces?.close();
  app.roleWork?.close();
  app.roleSuggestions?.close();
  app.modelTrust?.close();
  app.modelSettingsHistory?.close();
  app.modelBackends?.close();
  app.roundtable?.close();
  app.peer?.close();
  // The app runner records its last stops before the services store closes.
  return Promise.all([app.agentApps?.close(), app.employees?.close()]).finally(() => app.agentServices?.close());
}
