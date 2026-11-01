import * as dataFs from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createAppHost } from './app-host.js';
import { grantableTools } from './authorization.js';
import { appConflict } from './errors.js';
import { createHostIdentity } from './host-identity.js';
import { fuliHostTools } from './host-tools/fuli-tools.js';
import { createAppInstances } from './instances.js';
import { createAppOperations } from './operations.js';
import { createOwnerLeases } from './owner-lease.js';
import { createAppPages } from './pages.js';
import { createAppRemoval } from './removal.js';
import { createTrustedRunner } from './trusted-runner.js';
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
// runner and App Host (rec#7 PR②); pageFile serves a page to the console frame. resolveOwner is absent where no Agent can submit (the CLI).
export function createAgentAppService(options) {
  return agentAppServiceOver(agentAppContext(options));
}

// The CLI builds the context itself to add its terminal-confirmed decisions
// (confirmed-decisions.js) over the same registry.
export function agentAppServiceOver(context) {
  const host = createAppHost(context);
  return {
    ...createAppVersions(context),
    ...createAppRemoval(context),
    ...createAppViews(context),
    ...createAppPages(context),
    start: context.instances.start,
    stop: context.instances.stop,
    authorizeCall: host.authorizeCall,
    callTool: host.callTool,
    close: () => closeContext(context)
  };
}

// Closes once, however often it is asked: the instances this process holds
// are sealed and their processes stopped (instances.js) before the leases and
// the registry close. With nothing hosted or in flight the registry closes
// before this returns. Only a close that left nothing held or in flight is
// kept as done. One that could not confirm every app process stopped (a stop
// that failed, a late start's handle among them, or a start still in flight)
// rejects with close_incomplete and names them; their handles stay held, the
// records stay for the next owner's reconcile, and asking again retries those stops.
function closeContext(context) {
  const finish = () => {
    context.leases.close();
    context.store.close();
  };
  if (!context.closed) {
    const idle = context.instances.idle();
    const ending = context.instances.close();
    if (idle) finish();
    context.closed = idle ? Promise.resolve() : ending.finally(finish).then((result) => {
      if (result.complete) return;
      context.closed = null;
      throw appConflict('close_incomplete', 'FULI closed the registry but could not confirm that every app process it '
        + 'started has stopped; close again to retry, or end those processes yourself', result);
    });
  }
  return context.closed;
}

// One context is one FULI process's view of the registry: its owner lease
// identity (ownerKind: console, standalone or cli) and its in-process write
// gates. runner: what instances run in (trusted-runner.js: this version has
// no sandbox, so an approved app runs with the user's own permissions).
// serviceLog records each workbench instance in the services port
// (src/agent-services/port.js, workbench): absent in the CLI, which starts none.
// callFuliTool runs a granted FULI Agent tool for an app; hostTools,
// hostIdentity, dataFs, wait, closeWaitMs and timers are seams for synthetic tests.
export function agentAppContext({
  root, providerIdentity = null, resolveOwner = null, toolNames, clock = () => new Date(), ownerKind = 'cli',
  hostIdentity = createHostIdentity(), runner = createTrustedRunner({ hostIdentity }), callFuliTool = null,
  hostTools = null, fs = dataFs, wait, closeWaitMs, timers, serviceLog = null
}) {
  const store = new AgentAppStore(join(root, 'registry.sqlite'));
  const now = () => clock().toISOString();
  const context = {
    store, clock, now, resolveOwner, runner, wait, closeWaitMs, dataFs: fs, serviceLog,
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
    // start, stop and decisions on one app, one at a time (instances.js, operations.js).
    lifecycles: createWriteGates(),
    leases: createOwnerLeases({ store, hostIdentity, ownerKind, clock, now, timers })
  };
  context.instances = createAppInstances(context);
  context.operations = createAppOperations(context);
  return context;
}

