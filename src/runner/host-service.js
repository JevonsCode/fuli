import { hasPendingProjectMoves, priorHistoryDevices, savedMoveHistory } from './move-store.js';
import { hostProjectActions } from './host-project-actions.js';
import { startProjectCopies } from './project-copy-loop.js';
import { installationRecord } from './project-installation.js';
import { enrollInstallation } from './ownership-enrollment.js';
import { gateDirectory, markProjectConflict, readProjectGate } from './project-write-gate.js';
import { projectRegistry } from './project-creation.js';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

import { loadDeviceIdentity } from '../../packages/roundtable/src/peer/device-identity.js';
import { discoveryAdapters } from '../../packages/roundtable/src/peer/lan-addresses.js';
import { createBonjourDiscovery } from '../../packages/roundtable/src/peer/nearby-discovery.js';
import { discoverGuestAddresses } from '../server/lan-access.js';
import { globalIsCopyHere } from './global-copy.js';
import { startRunnerListener } from './host-listener.js';
import { createRunnerRoutes } from './host-routes.js';
import { RUNNER_HOST_FILE, RunnerHostStore } from './host-store.js';
import { displayName, encodeInvitation, newInvitationCode, RUNNER_PORT, RUNNER_SERVICE_TYPE } from './protocol.js';
import { grantScope } from './scope-grants.js';
import { GLOBAL_SCOPE } from './routes-store.js';

// This computer as a host of runners (docs/runner.md). The listener runs
// exactly while a runner is paired or an invitation is live. Every change, an
// invitation's expiry and, while one of them holds, a check every REDISCOVER_MS
// settle it again, one settle at a time: it looks up this computer's addresses
// and rebinds when they changed, ends the sessions of revoked runners, and
// retries after no network or a busy port. A host that never invited opens no
// store, no socket and no timer. While a runner is paired the host announces
// its certificate fingerprint over mDNS (the multicast sockets are open only
// then), so a runner on a network that gave the host another address finds it
// again. close() releases all of it: listener, sessions, mDNS, timer, store.
const REDISCOVER_MS = 60 * 1000;
const DEFAULT_HOST_NAME = 'FULI host';

export function createRunnerHost({ app, dataDir, withLease = (_owner, operation) => operation(),
  port = RUNNER_PORT, hostName = DEFAULT_HOST_NAME, discoverAddresses = discoverGuestAddresses,
  startListener = startRunnerListener, loadIdentity = () => loadDeviceIdentity(join(dataDir, 'peer')),
  createDiscovery = (options) => createBonjourDiscovery(options), consoleOrigin = () => null, onError = () => {},
  now = Date.now, scopeControls = false, projectCopies = false, projectMoves = false, enrollOwnership = false, prepareRuntime }) {
  const store = new RunnerHostStore(join(dataDir, RUNNER_HOST_FILE), { now, spaceId: () => app.config?.personal?.spaceId ?? null,
    onProjectConflict(space, project, generation) {
      if (identity && projectRegistry(dataDir, space)?.authority === identity.fingerprint) {
        markProjectConflict(gateDirectory(dataDir, space), project, generation);
      }
    } });
  let copies = null;
  let moves = null;
  let enrolling = null;
  let identity = null;
  let serving = null;
  let discovery = null;
  let advert = null;
  let problem = null;
  let timer = null;
  let settling = Promise.resolve();
  let closed = false;

  const settle = () => (settling = settling.then(settleNow, settleNow));

  function ownershipHello(peer) {
    const spaceId = app.config?.personal?.spaceId;
    if (!enrollOwnership || !spaceId || enrolling || !identity || globalIsCopyHere(dataDir)) return;
    const device = identity.fingerprint;
    if (projectRegistry(dataDir, spaceId)?.authority === device) return;
    const resuming = peer === null && installationRecord(dataDir)?.phase === 'preparing';
    const current = () => !closed && (resuming || store.isPaired(peer)) && app.config.personal.spaceId === spaceId && !globalIsCopyHere(dataDir);
    if (!current()) return;
    enrolling = Promise.resolve().then(() => withLease('runner-project-enrollment', () => enrollInstallation({ dataDir,
      descriptor: { spaceId, device, authority: device }, personal: app.personal, registry: store.ownership(), current, prepareRuntime })))
      .then(() => { if (current()) void settle(); }, onError).finally(() => { enrolling = null; });
  }

  async function settleNow() {
    clearTimeout(timer);
    timer = null;
    let wanted = true;
    try {
      wanted = await settleListener();
    } catch (error) {
      problem = 'unavailable';
      onError(error);
    }
    try {
      await settleMoves();
      if (!closed && enrollOwnership) {
        const record = installationRecord(dataDir);
        if (record?.phase === 'preparing' && record.space === app.config?.personal?.spaceId && record.device === record.authority) {
          identity ??= await loadIdentity();
          if (identity.fingerprint === record.device) { wanted = true; ownershipHello(null); }
        }
      }
    } catch (error) { problem = 'unavailable'; onError(error); }
    // Nothing to follow without a runner or an invitation: invite() and pairing settle again.
    if (closed || !wanted) return;
    const expiry = Date.parse(store.nextInvitationExpiry() ?? '');
    const wait = Number.isFinite(expiry) ? Math.min(Math.max(expiry - now(), 0) + 1, REDISCOVER_MS) : REDISCOVER_MS;
    timer = setTimeout(settle, wait);
    timer.unref?.();
  }

  async function settleListener() {
    const wanted = !closed && (store.hasRunners() || store.hasLiveInvitation());
    if (!wanted) {
      await stopServing();
      problem = null;
      return false;
    }
    const addresses = discoverAddresses();
    if (!addresses.length) {
      await stopServing();
      problem = 'no_network';
      return true;
    }
    identity ??= await loadIdentity();
    if (serving) {
      const paired = store.runners().filter(runner => !runner.revokedAt).map(runner => runner.fingerprint);
      await serving.routes.keepRunners(paired.filter(device => store.fullAccess(device)), paired);
      try {
        await serving.listener.rebind(addresses);
      } catch (error) {
        await stopServing();
        refused(error);
        return true;
      }
    } else {
      const routes = createRunnerRoutes({ app, store, hostName, hostFingerprint: identity.fingerprint, withLease,
        ownershipHello, reservationsEnabled: () => projectRegistry(dataDir, app.config.personal.spaceId)?.authority === identity.fingerprint,
        consoleOrigin, runtimeConfigPath: join(dataDir, 'graph-runtime.json'), onPaired: () => void settle(), now,
        moveControl: (peer, input) => moves?.control(peer, input),
        moveTicket: (peer, query) => moves?.ticket(peer, query),
        hostAddresses: () => serving?.listener.addresses ?? [], onOwnerConnected: device => copies?.connected(device),
        // A host that itself follows another computer for `global` keeps only a copy of it: not its to hand on.
        projectGeneration: scope => {
          if (!projectRegistry(dataDir, app.config.personal.spaceId)) return null;
          return ownsGrantScope(scope) ? store.ownership().owner(scope.slice('project:'.length)).generation : null;
        },
        ownsScope: scope => scope === GLOBAL_SCOPE ? !globalIsCopyHere(dataDir) : ownsGrantScope(scope) });
      try {
        serving = { routes, listener: await startListener({ identity, addresses, port, route: routes.handle,
          // A paired runner's connections are never held to one address's share
          // of the connections unknown devices on the network may hold.
          isPairedDevice: (fingerprint) => Boolean(fingerprint) && store.isPaired(fingerprint) }) };
      } catch (error) {
        await routes.close();
        refused(error);
        return true;
      }
    }
    const spaceId = app.config?.personal?.spaceId;
    if (projectCopies && spaceId && store.hasRunners() && projectRegistry(dataDir, spaceId)?.authority === identity.fingerprint) {
      copies ??= startProjectCopies({ dataDir, spaceId, device: identity.fingerprint, withLease, now, onError,
        personal: app.personal, registry: () => store.ownership(), request: serving.routes.ownerRequest });
    } else if (copies) {
      await copies.close();
      copies = null;
    }
    problem = null;
    announce(store.hasRunners());
    return true;
  }

  function announce(wanted) {
    if (!wanted || !serving) {
      advert?.stop();
      advert = null;
      discovery?.close();
      discovery = null;
      return;
    }
    if (advert) return;
    try {
      discovery ??= createDiscovery({ serviceType: RUNNER_SERVICE_TYPE,
        adapters: () => discoveryAdapters(networkInterfaces), onFailure: (error) => { advert = null; onError(error); } });
      advert = discovery.advertise({ name: `FULI runner host ${identity.fingerprint.slice(0, 8)}`,
        host: `fuli-host-${identity.fingerprint.slice(0, 8)}.local`, port: serving.listener.port,
        txt: { fp: identity.fingerprint } });
    } catch (error) {
      onError(error);
    }
  }

  async function settleMoves() {
    const space = app.config?.personal?.spaceId;
    const needed = !closed && projectMoves && space && (copies || hasPendingProjectMoves(dataDir, space));
    const descriptor = needed && projectRegistry(dataDir, space);
    if (descriptor && descriptor.device === descriptor.authority) {
      identity ??= await loadIdentity();
      if (descriptor.device === identity.fingerprint) {
        if (!moves) {
          const { hostMoveService } = await import('./move-service.js');
          moves = hostMoveService({ dataDir, descriptor, hostStore: store, onError, onIdle: () => { if (!copies) void settle(); },
            withPersonal: work => withLease('runner-project-move', () => work(app.personal)),
            request: job => serving?.routes.ownerRequest(job) ?? { ok: false, code: 'owner_offline' } });
        }
        return;
      }
    }
    await moves?.close();
    moves = null;
  }

  async function stopServing() {
    announce(false);
    if (!serving) return;
    const closing = serving;
    serving = null;
    await closing.routes.close();
    await closing.listener.close();
    await copies?.close();
    copies = null;
  }

  function refused(error) {
    problem = 'port_unavailable';
    onError(error);
  }

  const status = () => ({ listening: Boolean(serving), addresses: serving?.listener.addresses ?? [],
    port: serving?.listener.port ?? port, problem, fingerprint: identity?.fingerprint ?? null });

  const projectActions = () => {
    const spaceId = app.config?.personal?.spaceId;
    if (!projectCopies || !identity || !spaceId || projectRegistry(dataDir, spaceId)?.authority !== identity.fingerprint) return null;
    return hostProjectActions({ spaceId, device: identity.fingerprint, dataDir, now,
      registry: () => store.ownership(), changed: project => copies?.invalidate(project),
      request: job => serving?.routes.ownerRequest(job) ?? Promise.resolve({ ok: false, code: 'owner_offline' }) });
  };
  const ownsGrantScope = scope => {
    if (scope === GLOBAL_SCOPE) return !globalIsCopyHere(dataDir);
    const record = store.ownership().owner(scope.slice('project:'.length));
    return record?.state === 'owned' && record.owner === identity?.fingerprint;
  };
  return {
    // A one-use invitation for a computer the person names; the listener runs from now on.
    async invite({ name, scopes } = {}) {
      if (scopes !== undefined) {
        if (!scopeControls || !app.config?.personal?.spaceId) return { ok: false, code: 'scope_controls_unavailable' };
        identity ??= await loadIdentity();
        const space = app.config.personal.spaceId;
        if (!Array.isArray(scopes) || scopes.length > 64 || scopes.some(scope => !grantScope(scope))) {
          return { ok: false, code: 'scope_invalid' };
        }
        let singleProjects = [];
        if (scopes.some(scope => scope.startsWith('project:') && !ownsGrantScope(scope)) &&
          !projectRegistry(dataDir, space) && !globalIsCopyHere(dataDir) && app.personal?.ownProjectCatalog) {
          const catalog = await withLease('runner-invitation-catalog', () => app.personal.ownProjectCatalog(space, { includeProjects: true }));
          singleProjects = catalog.projects ?? [];
        }
        if (scopes.some(scope => !ownsGrantScope(scope) && (!scope.startsWith('project:') || !singleProjects.includes(scope.slice(8))))) {
          return { ok: false, code: 'scope_not_owned' };
        }
      }
      const code = newInvitationCode();
      const { expiresAt } = store.invite({ code, name: displayName(name, 'Runner'), scopes });
      await settle();
      if (!serving) return { ok: false, code: problem ?? 'unavailable' };
      return { ok: true, expiresAt, invitation: encodeInvitation({ name: hostName, addresses: serving.listener.addresses,
        port: serving.listener.port, certPem: identity.certPem, code }), ...status() };
    },
    ownerRequest(job, options) {
      return serving?.routes.ownerRequest(job, options) ?? Promise.resolve({ ok: false, dispatched: false, code: 'owner_offline' });
    },
    moveProject(input) { return moves?.start(input) ?? null; },
    async resumeInventory() {
      const row = installationRecord(dataDir);
      if (row?.phase === 'active' && row.space === app.config?.personal?.spaceId && row.device === row.authority) return this.ownershipDirectory();
      if (row?.phase !== 'preparing' || row.space !== app.config?.personal?.spaceId || row.device !== row.authority) {
        return { ok: false, code: 'inventory_not_preparing' };
      }
      await settle();
      await enrolling;
      const result = this.ownershipDirectory();
      return result.ready ? result : { ok: false, code: 'inventory_recheck_failed' };
    },
    ownershipDirectory(after = '') {
      const space = app.config?.personal?.spaceId;
      const local = space && projectRegistry(dataDir, space);
      if (!local || local.authority !== local.device || (identity && identity.fingerprint !== local.device)) return { ok: true, ready: false, preparing: Boolean(space && installationRecord(dataDir)?.phase === 'preparing' && !globalIsCopyHere(dataDir)), projects: [], moves: [] };
      const registry = store.ownership();
      const names = registry.directoryPage(after);
      const projects = names.slice(0, 50).map(row => {
        const copy = projectActions()?.source(row.project);
        let gate;
        try { gate = readProjectGate(gateDirectory(dataDir, space), row.project); } catch { gate = null; }
        return { ...row, gate: gate && { state: gate.state, role: gate.role, generation: gate.generation },
          source: copy, writableHere: row.state === 'owned' && row.owner === local.device &&
            gate?.role === 'owner' && gate.state === 'open' && gate.generation === row.generation };
      });
      return { ok: true, ready: true, device: local.device, pendingInventory: registry.pendingInventory(), projects, more: names.length > 50, moves: moves?.recent() ?? savedMoveHistory(dataDir, registry, space) };
    },
    historyLocation(project) {
      const space = app.config?.personal?.spaceId;
      const local = space && projectRegistry(dataDir, space);
      if (!local || (identity && identity.fingerprint !== local.device)) return null;
      const prior = priorHistoryDevices(dataDir, space, project);
      const owner = local.device === local.authority ? store.ownership().owner(project) : null;
      if (owner && owner.state !== 'owned') return null;
      if (!prior.length && (!owner || owner.owner === local.device)) return null;
      const names = new Map(store.runners().map(row => [row.fingerprint, row.name]));
      const device = key => ({ id: key, name: names.get(key) ?? null });
      return { here: device(local.device), owner: owner && device(owner.owner), prior: prior.map(device) };
    },
    moveStatus(project, id) {
      if (moves) return moves.status(project, id);
      const space = app.config?.personal?.spaceId;
      const local = space && projectRegistry(dataDir, space);
      if (!local || local.device !== local.authority || (identity && identity.fingerprint !== local.device)) return null;
      return savedMoveHistory(dataDir, store.ownership(), space, { project, id });
    },
    abandonMove(project, id) { return moves?.abandon(project, id) ?? null; },
    cancelMove(project, id) { return moves?.cancel(project, id) ?? null; },
    projectCopiesActive: () => Boolean(projectActions()),
    reportedProjects() { return projectActions()?.reportedProjects() ?? []; },
    projectSource(project) { return projectActions()?.source(project) ?? null; },
    projectCall(job) { return projectActions()?.call(job) ?? null; },
    inventoryStatus(fingerprint) { return store.ownership().inventoryStatus(fingerprint); },
    retireInventory(fingerprint, pairing) { return store.ownership().retireInventory(fingerprint, pairing); },
    grantList(fingerprint) {
      if (!scopeControls) return { ok: false, code: 'scope_controls_unavailable' };
      return store.grants(fingerprint).list();
    },
    async grantDecision(fingerprint, decision) {
      if (!scopeControls) return { ok: false, code: 'scope_controls_unavailable' };
      if (!grantScope(decision?.scope)) return { ok: false, code: 'scope_invalid' };
      if (decision.state === 'allowed' && !ownsGrantScope(decision.scope)) return { ok: false, code: 'scope_not_owned' };
      const result = store.grants(fingerprint).decide(decision);
      if (result.ok) await settle();
      return result;
    },
    list: () => ({ ok: true, runners: store.runners(), ...status() }),
    // fingerprint: the whole fingerprint or a prefix of at least 8 that names one paired runner.
    async revoke(fingerprint) {
      const matches = store.runners().filter((runner) => !runner.revokedAt && typeof fingerprint === 'string'
        && fingerprint.length >= 8 && runner.fingerprint.startsWith(fingerprint));
      if (matches.length !== 1 || !store.revoke(matches[0].fingerprint)) return { ok: false, code: 'runner_unknown' };
      await settle();
      return { ok: true };
    },
    // Called once the console listens: a runner paired before a restart is served again.
    start: settle,
    async close() {
      closed = true;
      await enrolling;
      await settle();
      store.close();
    }
  };
}
