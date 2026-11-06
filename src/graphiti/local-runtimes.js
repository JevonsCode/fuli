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
import { createAgentAvatars } from '../agent-avatars/port.js';
import { createProjectChangeLog } from '../project-change-log/port.js';
import { createPersonProfile } from '../person-profile/port.js';
import { entryPromptRecords } from '../agent-delegation/entry-prompts.js';
import { createWorkSurfaces } from '../work-surfaces/port.js';
import { createOldDataShelf } from '../old-data/port.js';
import { createOccupationPlugins } from '../occupation-plugins/port.js';
import { workSurfaceNames, workSurfaceSources } from '../work-surfaces/sources.js';
import { createAgentDirectorySnapshots } from '../agents/directory-snapshots.js';
import { attachExternalKnowledgeRuntime } from '../external-knowledge/runtime.js';
import { createSessionPreferenceDelivery } from '../conversations/preference-session.js';
import { createSessionPromptSentences } from './session-prompt-sentences.js';
import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { nativeChoiceAnswers } from '../agents/choice-answers.js';

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
  app.modelBackends = openModelBackendRuntime(paths);
  ({ trust: app.modelTrust, history: app.modelSettingsHistory } = openRoleTrustAndHistory(paths, app.modelBackends));
  attachJudgmentRuntime(app, paths);
  app.roleSuggestions = openRoleSuggestionLog(paths, { recoveryGate: app.knowledgeRecoveryGate });
  // Opens its file on the first registration; reads before that find none.
  app.standingAssignments = createStandingAssignments({ path: paths.standingAssignmentsPath });
  // Each Agent's own workflows (rec#60 D-78); the file is created by the first proposal.
  app.agentWorkflows = createAgentWorkflows({ path: join(dataDir, 'agent-workflows.sqlite') });
  // Which knowledge the automatic recall showed and which the Agent reported using (rec#63); recall reads it as a ranking prior.
  app.recallImpressions = new RecallImpressionsStore(join(dataDir, 'recall-impressions.sqlite'));
  // Each Agent's look as the person chose it (rec#11 D-89); the file is created by the first choice.
  app.agentAvatars = createAgentAvatars({ path: join(dataDir, 'agent-avatars.sqlite') });
  // What changed in each project's profile; the file is created by the first change.
  app.projectChangeLog = createProjectChangeLog({ path: join(dataDir, 'project-change-log.sqlite') });
  // The person's own name and picture (「我」); the file is created by the first change.
  app.personProfile = createPersonProfile({ path: join(dataDir, 'person-profile.json') });
  // The prompt of each session's current hook-entered task, kept only for the relay check (rec#80).
  app.entryPrompts = entryPromptRecords(dataDir);
  // What the person answered in the client's own question card, for the same check.
  app.nativeChoiceAnswers = task => nativeChoiceAnswers(task);
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
    openStore: () => createRoundtableStore(join(dataDir, 'agent-roundtable.sqlite'))
  });
}

// An application that only lives in memory opened none of them.
export function closeLocalRuntimes(app) {
  app.judgment?.close();
  app.standingAssignments?.close();
  app.agentWorkflows?.close();
  app.recallImpressions?.close();
  app.agentAvatars?.close();
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
