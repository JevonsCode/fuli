import { dirname, join } from 'node:path';
import { createEmployeeService } from '../employees/service.js';
import { agentAppRoot, createAgentAppService } from '../agent-apps/service.js';
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
  app.agentApps = createAgentAppService({
    root: agentAppRoot(runtimeConfigPath),
    providerIdentity,
    resolveOwner: (owner) => app.getProjectAgent(owner),
    toolNames: () => listAgentTools().map(({ name }) => name),
    ownerKind: 'console',
    callFuliTool: (name, input) => callAgentTool(app, name, input)
  });
  app.modelBackends = openModelBackendRuntime(paths);
  ({ trust: app.modelTrust, history: app.modelSettingsHistory } = openRoleTrustAndHistory(paths, app.modelBackends));
  attachJudgmentRuntime(app, paths);
  app.roleSuggestions = openRoleSuggestionLog(paths, { recoveryGate: app.knowledgeRecoveryGate });
  // Opens its file on the first registration; reads before that find none.
  app.standingAssignments = createStandingAssignments({ path: paths.standingAssignmentsPath });
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
  app.roleWork?.close();
  app.roleSuggestions?.close();
  app.modelTrust?.close();
  app.modelSettingsHistory?.close();
  app.modelBackends?.close();
  app.roundtable?.close();
  app.peer?.close();
  return Promise.all([app.agentApps?.close(), app.employees?.close()]);
}
