import { dirname, join } from 'node:path';
import { createEmployeeService } from '../employees/service.js';
import { agentAppRoot, createAgentAppService } from '../agent-apps/service.js';
import { createAgentServices } from '../agent-services/port.js';
import { callAgentTool, listAgentTools } from '../agent-tools.js';
import { createAgentRoundtable } from '../../packages/roundtable/src/roundtable/service.js';
import { createRoundtableStore } from '../../packages/roundtable/src/roundtable/store.js';
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
import { createAgentAvatars } from '../agent-avatars/port.js';
import { createWorkSurfaces } from '../work-surfaces/port.js';
import { workSurfaceNames, workSurfaceSources } from '../work-surfaces/sources.js';
import { createAgentDirectorySnapshots } from '../agents/directory-snapshots.js';
import { attachExternalKnowledgeRuntime } from '../external-knowledge/runtime.js';
import { createSessionPreferenceDelivery } from '../conversations/preference-session.js';

// The local stores and runtimes an application opened from a runtime
// directory owns. Adding one means opening it here and closing it below.
export function openLocalRuntimes(app, { runtimeConfigPath, paths, env, fetchImpl }) {
  const dataDir = dirname(runtimeConfigPath);
  const providerIdentity = app.config.personal.providerUrl;
  app.preferenceDelivery = createSessionPreferenceDelivery({
    directory: join(dataDir, 'preference-delivery'),
    env
  });
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
  app.modelBackends = openModelBackendRuntime(paths);
  ({ trust: app.modelTrust, history: app.modelSettingsHistory } = openRoleTrustAndHistory(paths, app.modelBackends));
  attachJudgmentRuntime(app, paths);
  app.roleSuggestions = openRoleSuggestionLog(paths, { recoveryGate: app.knowledgeRecoveryGate });
  // Opens its file on the first registration; reads before that find none.
  app.standingAssignments = createStandingAssignments({ path: paths.standingAssignmentsPath });
  // Each Agent's own workflows (rec#60 D-78); the file is created by the first proposal.
  app.agentWorkflows = createAgentWorkflows({ path: join(dataDir, 'agent-workflows.sqlite') });
  // Each Agent's look as the person chose it (rec#11 D-89); the file is created by the first choice.
  app.agentAvatars = createAgentAvatars({ path: join(dataDir, 'agent-avatars.sqlite') });
  // Every FLA's work surfaces in one table, with 全部暂停 and 恢复 (rec#11 D-85); the file is created by the first pause.
  app.workSurfaces = createWorkSurfaces({ path: join(dataDir, 'work-surfaces.sqlite'), sources: workSurfaceSources(app),
    names: (personalSpaceId) => workSurfaceNames(app, personalSpaceId) });
  app.roundtableHost = createFuliRoundtableHost(app);
  app.peer = createPeerPort({ dataDir, host: app.roundtableHost });
  app.roundtable = createAgentRoundtable({
    host: app.roundtableHost,
    peer: app.peer,
    env,
    openStore: () => createRoundtableStore(join(dataDir, 'agent-roundtable.sqlite'))
  });
}

// An application that only lives in memory opened none of them.
export function closeLocalRuntimes(app) {
  app.judgment?.close();
  app.standingAssignments?.close();
  app.agentWorkflows?.close();
  app.agentAvatars?.close();
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
