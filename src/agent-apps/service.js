import * as dataFs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createAppHost } from './app-host.js';
import { grantableTools } from './authorization.js';
import { createHostIdentity } from './host-identity.js';
import { fuliHostTools } from './host-tools/fuli-tools.js';
import { createAppInstances } from './instances.js';
import { NO_ISOLATION } from './isolation.js';
import { createAppOperations } from './operations.js';
import { createOwnerLeases } from './owner-lease.js';
import { createAppRemoval } from './removal.js';
import { AgentAppStore } from './store.js';
import { createAppVersions } from './versions.js';
import { createAppViews } from './views.js';
import { createWriteGates } from './write-gate.js';

// Agent apps live in FULI's own data directory beside employee packages, never
// in the read-only Agent directory projection under agents/.
export function agentAppRoot(runtimeConfigPath) {
  return join(dirname(runtimeConfigPath), 'agent-apps');
}

// The Agent app port. Agents reach submit/list/read through their FULI tools;
// approve, disable, rollback, deletion and export belong to the local user's
// CLI and HTTP routes; start, stop, authorizeCall and callTool are the app
// runner and App Host (rec#7 PR②). resolveOwner is absent where no Agent can submit (the CLI).
export function createAgentAppService(options) {
  return agentAppServiceOver(agentAppContext(options));
}

// The CLI builds the context itself to add its presence-checked decisions
// (verified-decisions.js) over the same registry.
export function agentAppServiceOver(context) {
  const host = createAppHost(context);
  return {
    ...createAppVersions(context),
    ...createAppRemoval(context),
    ...createAppViews(context),
    start: context.instances.start,
    stop: context.instances.stop,
    authorizeCall: host.authorizeCall,
    callTool: host.callTool,
    close: () => {
      context.leases.close();
      context.store.close();
    }
  };
}

// One context is one FULI process's view of the registry: its owner lease
// identity (ownerKind: console, standalone or cli) and its in-process write
// gates. platform: where the run gate looks for a presence check
// (src/presence/platforms.js). isolation: the backend instances run in
// (isolation.js; none in this version). callFuliTool runs a granted FULI Agent
// tool for an app; hostTools, hostIdentity, dataFs, wait and timers are seams
// for synthetic tests.
export function agentAppContext({
  root, providerIdentity = null, resolveOwner = null, toolNames, clock = () => new Date(), platform = process.platform,
  ownerKind = 'cli', isolation = NO_ISOLATION, callFuliTool = null, hostIdentity = createHostIdentity(),
  hostTools = null, fs = dataFs, wait, timers
}) {
  const store = new AgentAppStore(join(root, 'registry.sqlite'));
  const now = () => clock().toISOString();
  const context = {
    store, clock, now, resolveOwner, platform, isolation, wait, dataFs: fs,
    provider: providerIdentity === null ? null : String(providerIdentity).replace(/\/+$/, ''),
    packagesOf: (appId) => join(root, 'packages', appId),
    packageOf: (appId, version) => join(root, 'packages', appId, version),
    dataOf: (appId) => join(root, 'data', appId),
    // An app may be granted only what host-tools/catalog.js allows; never a
    // tool that grows or manages apps.
    grantable: () => grantableTools(toolNames()),
    // A process that hosts no instance (the CLI) has no tools to run for one.
    hostTools: hostTools ?? (() => (callFuliTool ? fuliHostTools({ toolNames, callFuliTool }) : new Map())),
    gates: createWriteGates(),
    leases: createOwnerLeases({ store, hostIdentity, ownerKind, clock, now, timers })
  };
  context.instances = createAppInstances(context);
  context.operations = createAppOperations(context);
  return context;
}

