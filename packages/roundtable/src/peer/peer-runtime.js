import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join as joinPath } from 'node:path';

import { startCoordinatorServer } from './coordinator-http.js';
import { cleanName, createCoordinatorService } from './coordinator-service.js';
import { createCoordinatorStore } from './coordinator-store.js';
import { loadDeviceIdentity } from './device-identity.js';
import { announcedAddresses, lanAddresses } from './lan-addresses.js';
import { createAttemptLedger } from './nearby-attempts.js';
import { createBonjourDiscovery } from './nearby-discovery.js';
import { createNearbyPairing } from './nearby-pairing.js';
import { createNearbyPresence } from './nearby-presence.js';
import { answersAs, connectNearby, createPeerClient, pairWithCoordinator } from './peer-transport.js';
import { coordinatorUrl, decodeInvitation, PeerError, shortFingerprint } from './protocol.js';
import { createPeerRunner } from './runner.js';

const PUBLISH_MS = 60_000;
const DIRECTORY_READ_MS = 3_000;
const WAKE_CLIENTS = new Set(['codex', 'claude_code']);
// While nearby pairing is on, its listener answers on every IPv4 interface:
// the address another computer reaches comes from discovery, not from the
// person. Afterwards it narrows to the address its paired devices use.
const NEARBY_LISTEN_HOST = '0.0.0.0';
// Nearby pairing turns itself off this long after the person turned it on,
// and shortly after a pairing finished (the other computer may still ask once).
const NEARBY_SESSION_MS = 30 * 60_000;
const PAIRED_GRACE_MS = 5_000;
// A device this computer trusted through nearby pairing that never connects
// within this time did not finish its side: the trust is taken back.
const TRUST_USE_MS = 60_000;
const LOOPBACK = /^(127\.|::1$)/;
const teamPeople = team => team?.people ?? [];

// The local owner's LAN roundtable controls, run only by the console process.
// Nothing here starts unless the owner turned it on; console LAN access does not.
export function createPeerRuntime({ host, roundtable, port, interfaces = networkInterfaces, allowLoopback = false,
  claimWaitMs, createDiscovery = createBonjourDiscovery, nearbyListenHost = NEARBY_LISTEN_HOST, clock = Date.now,
  nearbySessionMs = NEARBY_SESSION_MS, pairedGraceMs = PAIRED_GRACE_MS, trustUseMs = TRUST_USE_MS, onError = () => {} }) {
  const store = () => port.nodeStore();
  let coordinator = null;
  let runner = null;
  let runnerClient = null;
  let publisher = null;
  let leaveRetry = null;
  let leaveWork = null;
  let leaveAbort = null;
  let lastPublish = null;
  let repositoryKey = null;
  let nearbyNotice = null;
  let nearbyTimer = null;
  let listenFailure = null;
  const trustChecks = new Set();
  const spaceId = () => host.spaceId();
  const identity = () => loadDeviceIdentity(port.directory);
  const discovery = createDiscovery({ onFailure: (error) => endNearby({ kind: 'discovery_failed', reason: failureCode(error) })
    .catch(onError) });
  const presence = createNearbyPresence({ discovery, clock });
  const attempts = createAttemptLedger({ clock, read: () => (port.configured() ? store().setting('nearbyAttempts') : []),
    write: (entries) => store().setSetting('nearbyAttempts', entries) });
  const pairing = createNearbyPairing({ attempts, local: {
    identity, authority: () => port.localAuthority(),
    name: () => store().setting('nearby')?.name ?? 'FULI',
    role: nearbyRole,
    trusted: (fingerprint) => trustedFingerprints().includes(fingerprint),
    trustDevice: (peer) => {
      if (!coordinator) throw new PeerError('not_coordinator', 'This computer stopped coordinating', 409);
      coordinator.service.trustNearbyDevice(peer);
      watchTrustUse(peer);
    },
    untrustDevice: async (fingerprint) => { withdrawTrust(fingerprint); },
    joinCoordinator: async (peer) => adoptCoordinator({ url: coordinatorUrl(peer.address, peer.port), certPem: peer.certPem,
      fingerprint: peer.fingerprint, name: peer.name, authority: peer.authority }),
    reachable: async (peer) => answersAs({ identity: await identity(), address: peer.address, port: peer.port, fingerprint: peer.fingerprint }),
  }, connect: async (target) => connectNearby({ identity: await identity(), target }), clock,
  onPaired: (peer) => afterPairing(peer), onError });

  const localAddresses = () => lanAddresses(interfaces);

  async function resume() {
    if (!port.configured()) return;
    await finishLeaving();
    const settings = store().setting('coordinator');
    // An address that is gone (a new network, DHCP) is said, not replaced: nothing listens until the person acts.
    if (settings) await startCoordinator(settings).catch((error) => { onError(error); });
    if (store().setting('membership') && (coordinator || !settings)) await startRunner();
    checkPendingTrust();
    const nearby = store().setting('nearby');
    if (!nearby) return;
    if (!(nearby.until > clock())) await endNearby({ kind: 'timeout' });
    else if (settings && !coordinator) await endNearby(null);
    else await startNearby();
  }

  async function startCoordinator({ host: address, port: listenPort, name }) {
    const device = await identity();
    const authority = await port.localAuthority();
    const coordinatorStore = createCoordinatorStore(joinPath(port.directory, 'coordinator.sqlite'));
    let server = null;
    const service = createCoordinatorService({ store: coordinatorStore, identity: device, authority, name,
      onTrustChange: () => server?.refreshTrust() });
    try {
      server = await startCoordinatorServer({ service, identity: device, host: address, port: listenPort, claimWaitMs,
        nearby: { listening: () => nearbyRole().listening, handle: (...args) => pairing.handle(...args) },
        onReached: rememberReached });
    } catch (error) {
      coordinatorStore.close();
      listenFailure = { address, port: listenPort, code: failureCode(error), at: new Date(clock()).toISOString() };
      throw new PeerError('listen_failed', `Could not listen on ${address}:${listenPort}: ${failureCode(error)}`, 409);
    }
    listenFailure = null;
    coordinator = { service, server, store: coordinatorStore, host: address, name };
    // A wildcard listener answers this computer on loopback.
    const url = coordinatorUrl(address === NEARBY_LISTEN_HOST ? '127.0.0.1' : address, server.address.port);
    store().setSetting('coordinator', { host: address, port: server.address.port, name });
    store().setSetting('membership', { role: 'coordinator', coordinator: { url, certPem: device.certPem,
      fingerprint: device.fingerprint, name } });
    store().forgetAuthority(device.fingerprint);
    store().bindAuthority(device.fingerprint, authority, 'self');
  }

  async function startRunner() {
    if (runner) return;
    const membership = store().setting('membership');
    const device = await identity();
    runnerClient = createPeerClient({ identity: device, coordinator: membership.coordinator });
    runner = createPeerRunner({ store: store(), client: runnerClient, roundtable, host,
      nodeId: device.fingerprint, spaceId, onError });
    runner.start().catch(onError);
    await publish().catch(onError);
    publisher = setInterval(() => {
      publish().catch(onError);
      narrowListener().catch(onError);
    }, PUBLISH_MS);
    publisher.unref();
  }

  async function stopAll() {
    clearTimeout(leaveRetry);
    leaveRetry = null;
    leaveAbort?.abort();
    await leaveWork?.catch(onError);
    clearInterval(publisher);
    publisher = null;
    // Taken before awaiting, so two stops at once (a discovery failure during
    // another change) never close the same listener twice.
    const [stoppingRunner, stoppingClient, stoppingCoordinator] = [runner, runnerClient, coordinator];
    runner = null;
    runnerClient = null;
    coordinator = null;
    repositoryKey = null;
    await stoppingRunner?.stop();
    stoppingClient?.close();
    if (stoppingCoordinator) {
      await stoppingCoordinator.server.close();
      stoppingCoordinator.store.close();
    }
  }

  // Each share names the lead it was made for; after a handoff the old share
  // is withheld until the owner shares the project's new lead. A team that
  // cannot be read right now is no handoff: its share stays as last published.
  async function shareStates() {
    const projects = await host.listProjects().catch(() => []);
    const names = new Map(projects.map((project) => [project.projectId, project.name]));
    return Promise.all(store().shares().filter((share) => share.spaceId === spaceId()).map(async (share) => {
      const projectName = names.get(share.projectId) ?? share.projectId;
      let team;
      try { team = await host.projectTeam(share.projectId); }
      catch (error) { return { ...share, projectName, lead: null, state: 'team_unreadable', reason: error.code ?? 'team_unreadable' }; }
      const person = share.communicationOnly ? teamPeople(team).find(a => a.agentId === share.agentId) : team?.lead;
      const current = person?.agentId === share.agentId;
      return { ...share, projectName, lead: person ?? null,
        state: current ? 'shared' : team?.lead ? 'lead_changed' : 'lead_unavailable' };
    }));
  }

  const published = new Map();

  // What this device offers, sent to the coordinator now and every minute.
  // The outcome is kept for status, so a list the coordinator never got is
  // visible on the card and in `fuli peer status` instead of only in a log.
  async function publish() {
    if (!runnerClient) return;
    try {
      const profiles = await host.listAgents();
      const agents = (await shareStates()).flatMap((share) => {
        if (share.state === 'team_unreadable') return published.has(share.bindingId) ? [published.get(share.bindingId)] : [];
        if (share.state !== 'shared') return [];
        const profile = profiles.find(a => a.agentId === share.agentId);
        return [{ bindingId: share.bindingId, agentId: share.agentId, name: share.lead.name, employeeNumber: share.lead.employeeNumber,
          responsibility: share.lead.responsibility, projectName: share.projectName, projectId: share.projectId,
          occupation: profile?.occupation?.role ?? null, capabilities: profile?.profile.capabilities ?? [],
          ...(share.communicationOnly ? { communicationOnly: true } : {}), clients: share.clients }];
      });
      await runner?.reconcileShares(new Set(agents.map((agent) => agent.bindingId)));
      const sent = repositoryKey;
      const answer = await runnerClient.post('/peer/1/directory/publish', { agents,
        ...(sent ? { repositories: { keyId: sent.id, digests: await repositoryDigests(sent) } } : {}) });
      published.clear();
      for (const agent of agents) published.set(agent.bindingId, agent);
      lastPublish = { at: new Date().toISOString(), agents: agents.length, error: null };
      // The group's repository key comes with the answer; a new one means sending the digests again.
      if (validKey(answer.repositoryKey) && answer.repositoryKey.id !== sent?.id) {
        repositoryKey = answer.repositoryKey;
        await runnerClient.post('/peer/1/directory/publish', { agents,
          repositories: { keyId: repositoryKey.id, digests: await repositoryDigests(repositoryKey) } });
      }
    } catch (error) {
      lastPublish = { at: new Date().toISOString(), agents: null, error: error.code ?? 'publish_failed', message: error.message };
      throw error;
    }
  }

  // This device's own repository addresses, keyed with the paired group's
  // secret (from the coordinator, only after pairing): the coordinator matches
  // them between devices, and no device sees another device's digests.
  async function repositoryDigests(key) {
    const projects = await host.listProjects().catch(() => []);
    return [...new Set(projects.filter((project) => !project.temporary).flatMap((project) => projectDigests(project, key)))];
  }

  async function pairedDirectory() {
    if (!runnerClient) return [];
    try { return (await runnerClient.post('/peer/1/directory', {}, { timeoutMs: DIRECTORY_READ_MS })).devices ?? []; }
    catch { return []; }
  }

  // Projects the owner may share: each with its current lead, the clients that
  // lead may use and, for a project a paired device registered with the same
  // own repository, that device. A folder is offered only when this computer
  // knows one whose Git remote is that repository.
  async function shareable() {
    const list = (await host.listProjects().catch(() => [])).filter((project) => !project.temporary).slice(0, 50);
    const agents = await host.listAgents().catch(() => []);
    const paired = repositoryKey ? await pairedDirectory() : [];
    return Promise.all(list.map(async (project) => {
      const projectId = project.projectId;
      const team = await host.projectTeam(projectId).catch(() => null);
      const allowed = (agents.find((agent) => agent.agentId === team?.lead?.agentId)?.profile.allowedClients ?? [])
        .filter((client) => WAKE_CLIENTS.has(client));
      const digests = new Set(repositoryKey ? projectDigests(project, repositoryKey) : []);
      const sameProjectOn = paired.filter((device) => (device.sameRepositories ?? []).some((digest) => digests.has(digest)))
        .map(({ nodeId, name }) => ({ nodeId, name }));
      return { projectId, projectName: project.name ?? projectId,
        lead: team?.lead ? { agentId: team.lead.agentId, name: team.lead.name } : null, clients: allowed,
        communicationAgents: teamPeople(team).map(person => ({ agentId: person.agentId, name: person.name,
          occupation: agents.find(a => a.agentId === person.agentId)?.occupation?.role ?? null })),
        sameProjectOn, knownFolder: sameProjectOn.length && team?.lead ? await repositoryFolder(project, team.lead.agentId) : null };
    }));
  }

  async function repositoryFolder(project, agentId) {
    const folder = await roundtable.knownProjectFolder({ agentId, projectId: project.projectId }).catch(() => null);
    if (!folder || !host.folderRepository) return null;
    const remote = await Promise.resolve().then(() => host.folderRepository(folder)).catch(() => null);
    return remote && (project.repositories ?? []).includes(remote) ? folder : null;
  }

  async function status() {
    if (!port.configured()) {
      return { beta: true, role: null, device: null, coordinator: null, addresses: localAddresses(), devices: [],
        openInvitations: 0, shares: [], shareable: [], lastPublish: null, nearby: await nearbyView() };
    }
    const membership = store().setting('membership');
    const device = membership ? await identity() : null;
    const devices = membership?.role === 'coordinator' ? storedDevices() : [];
    return {
      beta: true,
      remoteRemovalPending: Boolean(store().setting('pendingLeave')),
      role: membership?.role ?? null,
      device: device ? { fingerprint: device.fingerprint, shortFingerprint: shortFingerprint(device.fingerprint) } : null,
      coordinator: membership ? { name: membership.coordinator.name, url: membership.coordinator.url,
        shortFingerprint: shortFingerprint(membership.coordinator.fingerprint), listening: Boolean(coordinator),
        listenFailure: membership.role === 'coordinator' && !coordinator ? listenFailure : null } : null,
      addresses: localAddresses(),
      devices: devices.map((entry) => ({ ...entry, shortFingerprint: shortFingerprint(entry.nodeId) })),
      openInvitations: coordinator ? coordinator.service.openInvitations() : 0,
      shares: membership ? (await shareStates()).map(({ lead: _lead, ...share }) => share) : [],
      shareable: membership ? await shareable() : [],
      lastPublish: membership ? lastPublish : null,
      nearby: await nearbyView(),
    };
  }

  async function enableCoordinator({ host: address, port: listenPort = 0, name }) {
    if (store().setting('membership')) throw new PeerError('already_paired', 'Turn the LAN roundtable off before changing its role', 409);
    const allowed = localAddresses();
    if (!(allowed.includes(address) || (allowLoopback && address === '127.0.0.1'))) {
      throw new PeerError('invalid_address', 'Choose one of this computer\'s network addresses', 422);
    }
    if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new PeerError('invalid_address', 'Invalid port', 422);
    await startCoordinator({ host: address, port: listenPort, name: cleanName(name) || 'FULI coordinator' });
    await startRunner();
    await startNearby();
    return status();
  }

  // A wildcard listener invites on the address paired devices already reach,
  // else the first physical LAN address, never a VPN or virtual adapter first.
  function createInvitation() {
    if (!coordinator) throw new PeerError('not_coordinator', 'Only the coordinator device creates invitations', 409);
    const settings = store().setting('coordinator');
    const known = store().setting('reachedAddresses') ?? {};
    const reached = trustedFingerprints().map((nodeId) => known[nodeId]).find((address) => address && !LOOPBACK.test(address));
    const address = settings.host === NEARBY_LISTEN_HOST ? reached ?? localAddresses()[0] : settings.host;
    if (!address) throw new PeerError('invalid_address', 'This computer has no LAN address to invite from', 409);
    return coordinator.service.createInvitation({ url: coordinatorUrl(address, settings.port) });
  }

  function previewInvitation(text) {
    const invitation = decodeInvitation(text);
    return { name: invitation.name, url: invitation.url, fingerprint: invitation.fingerprint,
      shortFingerprint: shortFingerprint(invitation.fingerprint), expiresAt: invitation.expiresAt };
  }

  async function join({ invitation: text, name }) {
    const membership = store().setting('membership');
    // A listener nearby pairing opened, with nobody paired through it, gives way to the invitation.
    if (membership && !(membership.role === 'coordinator' && store().setting('nearby')?.openedListener && !coordinatesOthers())) {
      throw new PeerError('already_paired', 'This device is already paired', 409);
    }
    await finishLeaving();
    if (store().setting('pendingLeave')) throw new PeerError('leave_pending', 'The previous coordinator is offline. Retry after it is available, or revoke this device there.', 409);
    const invitation = decodeInvitation(text);
    const result = await pairWithCoordinator({ identity: await identity(), authority: await port.localAuthority(), invitation,
      name: cleanName(name) || store().setting('nearby')?.name || 'FULI device' });
    if (result.coordinatorNodeId !== invitation.fingerprint) throw new PeerError('invalid_pairing', 'The coordinator answered with another identity', 502);
    await adoptCoordinator({ url: invitation.url, certPem: invitation.certificatePem, fingerprint: invitation.fingerprint,
      name: invitation.name, authority: invitation.authority });
    return status();
  }

  // Joins a coordinator: an invitation's, or the computer nearby pairing chose.
  // A listener without other paired devices closes first, so this computer
  // stops advertising itself as a place to pair.
  async function adoptCoordinator({ url, certPem, fingerprint, name, authority }) {
    const membership = store().setting('membership');
    if (membership?.role === 'member') throw new PeerError('already_paired', 'This device is already paired', 409);
    if (membership?.role === 'coordinator') {
      if (coordinatesOthers()) throw new PeerError('already_coordinating', 'This computer coordinates other devices', 409);
      await stopAll();
      store().setSetting('coordinator', null);
      const nearby = store().setting('nearby');
      if (nearby) store().setSetting('nearby', { ...nearby, openedListener: false });
    }
    store().forgetAuthority(fingerprint);
    store().bindAuthority(fingerprint, authority, 'pairing');
    store().setSetting('membership', { role: 'member', coordinator: { url, certPem, fingerprint, name: name || 'FULI coordinator' } });
    await startRunner();
    await startNearby();
  }

  // The owner picks each project, the clients it may be woken in and,
  // optionally, its folder; each share is bound to that project's current lead.
  async function setShares({ shares: wanted }) {
    if (!store().setting('membership')) throw new PeerError('peer_not_paired', 'Pair this computer before sharing a project', 409);
    if (!Array.isArray(wanted) || wanted.length > 50) throw new PeerError('invalid_shares', 'Choose up to 50 projects', 422);
    const agents = await host.listAgents();
    const shares = [];
    for (const entry of wanted) {
      const projectId = entry?.projectId;
      if (typeof projectId !== 'string' || !projectId) throw new PeerError('invalid_shares', 'A shared Agent needs a project', 422);
      const team = await host.projectTeam(projectId);
      const communicationOnly = entry.communicationOnly === true;
      const target = communicationOnly ? teamPeople(team).find(a => a.agentId === entry.agentId) : team.lead;
      if (!target) throw new PeerError('lead_unavailable', 'A share needs an active assigned Agent; execution requires the project lead', 409);
      if (shares.some(s => s.projectId === projectId && s.agentId === target.agentId)) throw new PeerError('invalid_shares', 'List each project Agent once', 422);
      const allowed = (agents.find((agent) => agent.agentId === target.agentId)?.profile.allowedClients ?? [])
        .filter((client) => WAKE_CLIENTS.has(client));
      const clients = Array.isArray(entry.clients) ? [...new Set(entry.clients)] : [];
      if ((!communicationOnly && !clients.length) || !clients.every((client) => allowed.includes(client)) || (communicationOnly && clients.length)) {
        throw new PeerError('invalid_clients', 'Choose at least one client the project lead may use', 422);
      }
      if (communicationOnly && entry.workingDirectory) throw new PeerError('invalid_shares', 'Communication-only shares have no working directory', 422);
      shares.push({ spaceId: spaceId(), projectId, agentId: target.agentId, clients,
        ...(communicationOnly ? { communicationOnly: true } : {}),
        workingDirectory: entry.workingDirectory ? await confirmedFolder(entry.workingDirectory, projectId) : null });
    }
    store().replaceShares(shares, port.idFactory);
    await runner?.reconcileShares();
    // A list the coordinator did not get is said here, not only in the log.
    try { await publish(); }
    catch (error) {
      throw new PeerError('share_not_published', `Saved here, but the coordinator did not get the list (${error.code ?? 'error'}: ${error.message}); FULI retries every minute`, 502);
    }
    return status();
  }

  // A folder is accepted only when the host's own project resolution maps it to this project.
  async function confirmedFolder(folder, projectId) {
    let resolved;
    try { resolved = await host.projectForPath(folder); }
    catch { throw new PeerError('invalid_folder', 'Choose an existing folder of this project', 422); }
    if (resolved !== projectId) {
      throw new PeerError('invalid_folder', 'That folder does not belong to this project', 422);
    }
    return folder;
  }

  async function revokeDevice(nodeId) {
    if (!coordinator) throw new PeerError('not_coordinator', 'Only the coordinator device revokes devices', 409);
    coordinator.service.revoke(nodeId);
    store().forgetAuthority(nodeId);
    return status();
  }

  // Leaves the LAN roundtable. History stays; trust, sharing, listening and nearby discovery end.
  async function disable() {
    stopNearby();
    const membership = store().setting('membership');
    // A coordinator turned on again later must not silently trust old devices,
    // even when its listener could not start: the store itself is revoked.
    for (const device of storedDevices()) if (!device.self && device.status === 'active') revokeStored(device.nodeId);
    await stopAll();
    store().replaceShares([], port.idFactory);
    store().forgetAuthorities();
    store().setSetting('membership', null);
    store().setSetting('coordinator', null);
    store().setSetting('reachedAddresses', null);
    store().setSetting('pendingTrust', null);
    listenFailure = null;
    if (membership?.role === 'member') store().setSetting('pendingLeave', membership.coordinator);
    await finishLeaving();
    return status();
  }

  // ---- Coordinator trust, also while its listener is not running ----

  // The devices this computer's coordinator store trusts, read from the running
  // service or, when its listener could not start, from the store file itself.
  function storedDevices() {
    if (coordinator) return coordinator.service.devices();
    const path = joinPath(port.directory, 'coordinator.sqlite');
    if (!port.configured() || !existsSync(path) || store().setting('membership')?.role !== 'coordinator') return [];
    const selfId = store().setting('membership').coordinator.fingerprint;
    const coordinatorStore = createCoordinatorStore(path);
    try {
      return coordinatorStore.nodes().map((node) => ({ nodeId: node.id, name: node.name, status: node.status, self: node.id === selfId,
        pairedAt: node.paired_at, revokedAt: node.revoked_at, lastSeenAt: node.last_seen_at ?? null, online: false,
        sharedAgents: JSON.parse(node.directory_json).length }));
    } finally { coordinatorStore.close(); }
  }

  function revokeStored(nodeId) {
    if (coordinator) coordinator.service.revoke(nodeId);
    else {
      const coordinatorStore = createCoordinatorStore(joinPath(port.directory, 'coordinator.sqlite'));
      try { coordinatorStore.revokeNode(nodeId, new Date(clock()).toISOString()); } finally { coordinatorStore.close(); }
    }
    store().forgetAuthority(nodeId);
  }

  // ---- Nearby pairing (rec issue 127) ----

  const coordinatesOthers = () => storedDevices().some((device) => !device.self && device.status === 'active');

  function trustedFingerprints() {
    if (store().setting('membership')?.role === 'coordinator') {
      return storedDevices().filter((device) => !device.self && device.status === 'active').map((device) => device.nodeId);
    }
    const membership = store().setting('membership');
    return membership?.role === 'member' ? [membership.coordinator.fingerprint] : [];
  }

  function nearbyRole() {
    const settings = port.configured() ? store().setting('nearby') : null;
    if (!settings) return { listening: false, reason: 'Turn nearby pairing on first' };
    const membership = store().setting('membership');
    if (membership?.role === 'member') {
      return { listening: false, reason: `This computer is paired through ${membership.coordinator.name}; pair other computers there` };
    }
    if (!coordinator) return { listening: false, reason: 'This computer is not listening for nearby pairing' };
    return { listening: true, coordinatesOthers: coordinatesOthers(), listenPort: coordinator.server.address.port };
  }

  async function nearbyView() {
    const settings = port.configured() ? store().setting('nearby') : null;
    const trusted = settings ? trustedFingerprints() : [];
    const role = nearbyRole();
    const budget = attempts.summary();
    return { on: Boolean(settings), name: settings?.name ?? null,
      suggestedName: port.configured() ? defaultName(await identity()) : null,
      canPair: role.listening && !budget.limited, reason: settings && !role.listening ? role.reason : null,
      until: settings?.until ? new Date(settings.until).toISOString() : null,
      attempts: budget, limited: budget.limited,
      devices: settings ? presence.list().map((entry) => ({ ...entry,
        paired: trusted.some((fingerprint) => fingerprint.startsWith(entry.fingerprint)) })) : [],
      pairing: pairing.view(), ended: nearbyNotice };
  }

  async function startNearby() {
    const settings = store().setting('nearby');
    if (!settings) return;
    const device = await identity();
    presence.browse(device.fingerprint);
    if (coordinator) {
      presence.advertise({ name: settings.name, port: coordinator.server.address.port, fingerprint: device.fingerprint,
        addresses: coordinator.host === NEARBY_LISTEN_HOST ? announcedAddresses(interfaces) : [coordinator.host] });
    } else presence.stopAdvertising();
    clearTimeout(nearbyTimer);
    nearbyTimer = setTimeout(() => endNearby({ kind: 'timeout' }).catch(onError), Math.max(0, settings.until - clock()));
    nearbyTimer.unref?.();
  }

  function stopNearby() {
    clearTimeout(nearbyTimer);
    nearbyTimer = null;
    pairing.close();
    presence.stop();
    if (port.configured()) store().setSetting('nearby', null);
  }

  // Turns nearby pairing on: advertise, list the others, and listen for a
  // pairing request. A computer not yet paired opens its own listener for it;
  // one that listens on an address the person chose listens everywhere for now
  // and returns to that address when nearby pairing turns off. Turning it on
  // again while on keeps its end time.
  async function nearbyOn({ name } = {}) {
    const previous = store().setting('nearby');
    const chosen = cleanName(name) || previous?.name || defaultName(await identity());
    const opened = !store().setting('membership');
    let previousHost = previous?.previousHost ?? null;
    if (opened) {
      if (store().setting('pendingLeave')) throw new PeerError('leave_pending', 'The previous coordinator is offline. Retry after it is available, or revoke this device there.', 409);
      await startCoordinator({ host: nearbyListenHost, port: 0, name: chosen });
    } else if (!previous && coordinator && coordinator.host !== NEARBY_LISTEN_HOST && coordinator.host !== nearbyListenHost) {
      previousHost = coordinator.host;
      await rebindCoordinator(nearbyListenHost);
    } else if (!previous && !coordinator && store().setting('membership')?.role === 'coordinator') {
      throw new PeerError('listen_failed', 'The LAN roundtable is not listening; turn it off and on again first', 409);
    }
    nearbyNotice = null;
    store().setSetting('nearby', { name: chosen, openedListener: opened || Boolean(previous?.openedListener), previousHost,
      until: previous?.until > clock() ? previous.until : clock() + nearbySessionMs });
    if (opened) await startRunner();
    await startNearby();
    return status();
  }

  async function nearbyOff() {
    await endNearby(null);
    return status();
  }

  // Stops advertising and listing. A listener nearby pairing opened, with no
  // device paired through it, closes too, so nothing listens while off; one
  // that had an address the person chose returns to it; otherwise it narrows
  // to the address its paired devices use.
  async function endNearby(notice) {
    const settings = port.configured() ? store().setting('nearby') : null;
    stopNearby();
    if (notice) nearbyNotice = { ...notice, at: new Date(clock()).toISOString() };
    if (settings?.openedListener && store().setting('membership')?.role === 'coordinator' && !coordinatesOthers()) await disable();
    else if (settings?.previousHost && coordinator?.host !== settings.previousHost) await rebindCoordinator(settings.previousHost);
    else await narrowListener();
  }

  function afterPairing(peer) {
    nearbyNotice = { kind: 'paired', name: peer.name, at: new Date(clock()).toISOString() };
    const timer = setTimeout(() => endNearby({ kind: 'paired', name: peer.name }).catch(onError), pairedGraceMs);
    timer.unref?.();
  }

  // Where each paired device last reached this listener, kept across restarts.
  function rememberReached(nodeId, address) {
    store().setSetting('reachedAddresses', { ...(store().setting('reachedAddresses') ?? {}), [nodeId]: address });
    if (!store().setting('nearby')) narrowListener().catch(onError);
  }

  // While nearby pairing is off, a wildcard listener moves to the one address
  // its paired devices reached it on, or, when none has connected yet, to this
  // computer's first physical LAN address; devices on several addresses keep it everywhere.
  async function narrowListener() {
    if (!coordinator || coordinator.host !== NEARBY_LISTEN_HOST || store().setting('nearby')) return;
    const reached = store().setting('reachedAddresses') ?? {};
    const addresses = new Set(trustedFingerprints().map((nodeId) => reached[nodeId]).filter((address) => address && !LOOPBACK.test(address)));
    const address = addresses.size === 1 ? [...addresses][0] : addresses.size === 0 ? localAddresses()[0] : null;
    if (address) await rebindCoordinator(address);
  }

  // Moves the listener to another address on the same port. When that fails it
  // tries the address it had; when that fails too nothing listens and the
  // card and `fuli peer status` say why. Trust never changes here.
  async function rebindCoordinator(address) {
    const settings = store().setting('coordinator');
    await stopAll();
    try { await startCoordinator({ host: address, port: settings.port, name: settings.name }); }
    catch (error) {
      onError(error);
      const failure = listenFailure;
      try { await startCoordinator({ host: settings.host, port: settings.port, name: settings.name }); }
      catch (again) { onError(again); return; }
      listenFailure = failure;
    }
    await startRunner();
  }

  // Trust written for a nearby pairing is kept only once the other computer
  // used it; a side that never finished leaves nothing trusted here. The
  // deadline is stored, so a restart inside it still checks.
  function watchTrustUse(peer) {
    const pending = (store().setting('pendingTrust') ?? []).filter((entry) => entry.fingerprint !== peer.fingerprint);
    store().setSetting('pendingTrust', [...pending, { fingerprint: peer.fingerprint, name: peer.name, deadline: clock() + trustUseMs }]);
    scheduleTrustCheck(trustUseMs);
  }

  function scheduleTrustCheck(delayMs) {
    const timer = setTimeout(() => { trustChecks.delete(timer); checkPendingTrust(); }, delayMs);
    timer.unref?.();
    trustChecks.add(timer);
  }

  function checkPendingTrust() {
    if (!port.configured()) return;
    const pending = store().setting('pendingTrust') ?? [];
    if (!pending.length) return;
    const now = clock();
    const devices = storedDevices();
    const waiting = [];
    for (const entry of pending) {
      const device = devices.find((candidate) => candidate.nodeId === entry.fingerprint && candidate.status === 'active');
      const used = device?.lastSeenAt && Date.parse(device.lastSeenAt) >= Date.parse(device.pairedAt);
      if (!device || used) continue;
      if (entry.deadline > now) { waiting.push(entry); continue; }
      revokeStored(entry.fingerprint);
      nearbyNotice = { kind: 'trust_withdrawn', name: entry.name, at: new Date(now).toISOString() };
    }
    store().setSetting('pendingTrust', waiting.length ? waiting : null);
    if (waiting.length) scheduleTrustCheck(Math.max(0, Math.min(...waiting.map((entry) => entry.deadline)) - now));
  }

  function withdrawTrust(fingerprint) {
    if (!storedDevices().some((entry) => entry.nodeId === fingerprint && entry.status === 'active')) return;
    revokeStored(fingerprint);
  }

  async function pairNearby({ fingerprint }) {
    const prefix = String(fingerprint ?? '').replace(/\s+/g, '').toLowerCase();
    if (!/^[0-9a-f]{4,64}$/.test(prefix)) {
      throw new PeerError('invalid_fingerprint', 'Pass at least the first 4 characters of a fingerprint from the nearby list', 422);
    }
    const matches = presence.list().filter((entry) => prefix.startsWith(entry.fingerprint) || entry.fingerprint.startsWith(prefix));
    if (!matches.length) throw new PeerError('nearby_not_found', 'No nearby FULI has that fingerprint; list them again', 404);
    if (matches.length > 1) throw new PeerError('nearby_ambiguous', 'Several nearby FULI start with that fingerprint; pass more of it', 409);
    await pairing.start(matches[0]);
    return status();
  }

  async function confirmPairing({ requestId, code }) {
    pairing.confirm({ requestId, code });
    return status();
  }

  async function cancelPairing() {
    pairing.cancel();
    return status();
  }

  // The person on this computer clears the pairing attempts (local only, never an Agent).
  async function clearPairingAttempts() {
    if (port.configured()) attempts.clear();
    return status();
  }

  // Local execution stops even if the coordinator is offline. Keep only the
  // unpairing request until it can be delivered, without resuming any shares.
  function finishLeaving() {
    if (leaveWork) return leaveWork;
    leaveWork = deliverLeave().finally(() => { leaveWork = null; leaveAbort = null; });
    return leaveWork;
  }

  async function deliverLeave() {
    clearTimeout(leaveRetry);
    leaveRetry = null;
    const previous = store().setting('pendingLeave');
    if (!previous) return;
    leaveAbort = new AbortController();
    const client = createPeerClient({ identity: await identity(), coordinator: previous });
    try {
      await client.post('/peer/1/leave', {}, { timeoutMs: 2_000, signal: leaveAbort.signal });
      store().setSetting('pendingLeave', null);
    } catch (error) {
      if (leaveAbort.signal.aborted) return;
      if (error.status === 403) store().setSetting('pendingLeave', null);
      else {
        onError(error);
        leaveRetry = setTimeout(() => finishLeaving().catch(onError), PUBLISH_MS);
        leaveRetry.unref();
      }
    } finally { client.close(); }
  }

  async function close() {
    clearTimeout(nearbyTimer);
    for (const timer of trustChecks) clearTimeout(timer);
    trustChecks.clear();
    pairing.close();
    presence.stop();
    await stopAll();
  }

  return { resume, status, enableCoordinator, createInvitation, previewInvitation, join, setShares, revokeDevice, disable,
    nearbyOn, nearbyOff, pairNearby, confirmPairing, cancelPairing, clearPairingAttempts, publish, close, runnerActive: () => Boolean(runner) };
}

// The name another computer sees until the person types one: never this computer's own name.
function defaultName(device) {
  return `FULI ${device.fingerprint.slice(12, 16).toUpperCase()}`;
}

// A failure's code as shown to the person: a known word, never free text.
function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'error';
  return /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : 'error';
}

function validKey(value) {
  return typeof value?.id === 'string' && typeof value?.key === 'string' && value.key.length >= 32;
}

// One project's own repository addresses (host Project.repositories) keyed
// with the paired group's secret; the same address gives the same digest.
function projectDigests(project, key) {
  return (project.repositories ?? []).map((address) => createHmac('sha256', key.key).update(`fuli-repository:${address}`).digest('hex').slice(0, 32));
}
