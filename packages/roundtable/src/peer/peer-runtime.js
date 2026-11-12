import { hostname, networkInterfaces } from 'node:os';
import { join as joinPath } from 'node:path';

import { startCoordinatorServer } from './coordinator-http.js';
import { cleanName, createCoordinatorService } from './coordinator-service.js';
import { createCoordinatorStore } from './coordinator-store.js';
import { loadDeviceIdentity } from './device-identity.js';
import { createBonjourDiscovery } from './nearby-discovery.js';
import { createNearbyPairing } from './nearby-pairing.js';
import { createNearbyPresence } from './nearby-presence.js';
import { answersAs, connectNearby, createPeerClient, pairWithCoordinator } from './peer-transport.js';
import { coordinatorUrl, decodeInvitation, PeerError, sha256Hex, shortFingerprint } from './protocol.js';
import { createPeerRunner } from './runner.js';

const PUBLISH_MS = 60_000;
const DIRECTORY_READ_MS = 3_000;
const WAKE_CLIENTS = new Set(['codex', 'claude_code']);
// Nearby pairing listens on every IPv4 interface: the address another
// computer reaches comes from discovery, not from the person.
const NEARBY_LISTEN_HOST = '0.0.0.0';
const teamPeople = team => team?.people ?? [];

// The local owner's LAN roundtable controls, run only by the console process.
// Nothing here starts unless the owner turned it on; console LAN access does not.
export function createPeerRuntime({ host, roundtable, port, interfaces = networkInterfaces, allowLoopback = false,
  claimWaitMs, discovery = createBonjourDiscovery(), nearbyListenHost = NEARBY_LISTEN_HOST, onError = () => {} }) {
  const store = () => port.nodeStore();
  let coordinator = null;
  let runner = null;
  let runnerClient = null;
  let publisher = null;
  let leaveRetry = null;
  let leaveWork = null;
  let leaveAbort = null;
  let lastPublish = null;
  const spaceId = () => host.spaceId();
  const identity = () => loadDeviceIdentity(port.directory);
  const presence = createNearbyPresence({ discovery });
  const pairing = createNearbyPairing({ local: {
    identity, authority: () => port.localAuthority(),
    name: () => store().setting('nearby')?.name ?? 'FULI',
    role: nearbyRole,
    trusted: (fingerprint) => trustedFingerprints().includes(fingerprint),
    trustDevice: (peer) => {
      if (!coordinator) throw new PeerError('not_coordinator', 'This computer stopped coordinating', 409);
      return coordinator.service.trustNearbyDevice(peer);
    },
    untrustDevice: async (fingerprint) => { coordinator?.service.revoke(fingerprint); },
    joinCoordinator: async (peer) => adoptCoordinator({ url: coordinatorUrl(peer.address, peer.port), certPem: peer.certPem,
      fingerprint: peer.fingerprint, name: peer.name, authority: peer.authority }),
    reachable: async (peer) => answersAs({ identity: await identity(), address: peer.address, port: peer.port, fingerprint: peer.fingerprint }),
  }, connect: async (target) => connectNearby({ identity: await identity(), target }), onError });

  function localAddresses() {
    return Object.values(interfaces()).flat().filter((entry) => entry && !entry.internal
      && (entry.family === 'IPv4' || entry.family === 4)).map((entry) => entry.address);
  }

  async function resume() {
    if (!port.configured()) return;
    await finishLeaving();
    const settings = store().setting('coordinator');
    if (settings) await startCoordinator(settings);
    if (store().setting('membership')) await startRunner();
    await startNearby();
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
        nearby: { handle: (...args) => pairing.handle(...args) } });
    } catch (error) {
      coordinatorStore.close();
      throw new PeerError('listen_failed', `Could not listen on ${address}:${listenPort}: ${error.code ?? error.message}`, 409);
    }
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
    publisher = setInterval(() => publish().catch(onError), PUBLISH_MS);
    publisher.unref();
  }

  async function stopAll() {
    clearTimeout(leaveRetry);
    leaveRetry = null;
    leaveAbort?.abort();
    await leaveWork?.catch(onError);
    clearInterval(publisher);
    publisher = null;
    await runner?.stop();
    runner = null;
    runnerClient?.close();
    runnerClient = null;
    if (coordinator) {
      await coordinator.server.close();
      coordinator.store.close();
      coordinator = null;
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
      await runnerClient.post('/peer/1/directory/publish', { agents, repositories: await repositoryDigests() });
      published.clear();
      for (const agent of agents) published.set(agent.bindingId, agent);
      lastPublish = { at: new Date().toISOString(), agents: agents.length, error: null };
    } catch (error) {
      lastPublish = { at: new Date().toISOString(), agents: null, error: error.code ?? 'publish_failed', message: error.message };
      throw error;
    }
  }

  // Digests of the own repository addresses of this device's projects, so
  // paired devices see which projects they share without the addresses.
  async function repositoryDigests() {
    const projects = await host.listProjects().catch(() => []);
    return [...new Set(projects.filter((project) => !project.temporary).flatMap(projectDigests))];
  }

  async function pairedDirectory() {
    if (!runnerClient) return [];
    try { return (await runnerClient.post('/peer/1/directory', {}, { timeoutMs: DIRECTORY_READ_MS })).devices ?? []; }
    catch { return []; }
  }

  // Projects the owner may share: each with its current lead, the clients that
  // lead may use and, for a project a paired device registered with the same
  // own repository, that device and the folder this computer knows for it.
  async function shareable() {
    const list = (await host.listProjects().catch(() => [])).filter((project) => !project.temporary).slice(0, 50);
    const agents = await host.listAgents().catch(() => []);
    const paired = await pairedDirectory();
    return Promise.all(list.map(async (project) => {
      const projectId = project.projectId;
      const team = await host.projectTeam(projectId).catch(() => null);
      const allowed = (agents.find((agent) => agent.agentId === team?.lead?.agentId)?.profile.allowedClients ?? [])
        .filter((client) => WAKE_CLIENTS.has(client));
      const digests = new Set(projectDigests(project));
      const sameProjectOn = paired.filter((device) => (device.repositories ?? []).some((digest) => digests.has(digest)))
        .map(({ nodeId, name }) => ({ nodeId, name }));
      const knownFolder = sameProjectOn.length && team?.lead
        ? await roundtable.knownProjectFolder({ agentId: team.lead.agentId, projectId }).catch(() => null) : null;
      return { projectId, projectName: project.name ?? projectId,
        lead: team?.lead ? { agentId: team.lead.agentId, name: team.lead.name } : null, clients: allowed,
        communicationAgents: teamPeople(team).map(person => ({ agentId: person.agentId, name: person.name,
          occupation: agents.find(a => a.agentId === person.agentId)?.occupation?.role ?? null })),
        sameProjectOn, knownFolder };
    }));
  }

  async function status() {
    if (!port.configured()) {
      return { beta: true, role: null, device: null, coordinator: null, addresses: localAddresses(), devices: [],
        openInvitations: 0, shares: [], shareable: [], lastPublish: null, nearby: nearbyView() };
    }
    const membership = store().setting('membership');
    const device = membership ? await identity() : null;
    let devices = [];
    if (coordinator) devices = coordinator.service.devices();
    return {
      beta: true,
      remoteRemovalPending: Boolean(store().setting('pendingLeave')),
      role: membership?.role ?? null,
      device: device ? { fingerprint: device.fingerprint, shortFingerprint: shortFingerprint(device.fingerprint) } : null,
      coordinator: membership ? { name: membership.coordinator.name, url: membership.coordinator.url,
        shortFingerprint: shortFingerprint(membership.coordinator.fingerprint), listening: Boolean(coordinator) } : null,
      addresses: localAddresses(),
      devices: devices.map((entry) => ({ ...entry, shortFingerprint: shortFingerprint(entry.nodeId) })),
      openInvitations: coordinator ? coordinator.service.openInvitations() : 0,
      shares: membership ? (await shareStates()).map(({ lead: _lead, ...share }) => share) : [],
      shareable: membership ? await shareable() : [],
      lastPublish: membership ? lastPublish : null,
      nearby: nearbyView(),
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

  function createInvitation() {
    if (!coordinator) throw new PeerError('not_coordinator', 'Only the coordinator device creates invitations', 409);
    const settings = store().setting('coordinator');
    const address = settings.host === NEARBY_LISTEN_HOST ? localAddresses()[0] : settings.host;
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
    // A coordinator turned on again later must not silently trust old devices.
    for (const device of coordinator?.service.devices() ?? []) {
      if (!device.self && device.status === 'active') coordinator.service.revoke(device.nodeId);
    }
    await stopAll();
    store().replaceShares([], port.idFactory);
    store().forgetAuthorities();
    store().setSetting('membership', null);
    store().setSetting('coordinator', null);
    if (membership?.role === 'member') store().setSetting('pendingLeave', membership.coordinator);
    await finishLeaving();
    return status();
  }

  // ---- Nearby pairing (rec issue 127) ----

  const coordinatesOthers = () => Boolean(coordinator?.service.devices().some((device) => !device.self && device.status === 'active'));

  function trustedFingerprints() {
    if (coordinator) return coordinator.service.devices().filter((device) => !device.self && device.status === 'active').map((device) => device.nodeId);
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

  function nearbyView() {
    const settings = port.configured() ? store().setting('nearby') : null;
    const trusted = settings ? trustedFingerprints() : [];
    const role = nearbyRole();
    return { on: Boolean(settings), name: settings?.name ?? null, suggestedName: cleanName(hostname()) || 'FULI',
      canPair: role.listening, reason: settings && !role.listening ? role.reason : null,
      devices: settings ? presence.list().map((entry) => ({ ...entry,
        paired: trusted.some((fingerprint) => fingerprint.startsWith(entry.fingerprint)) })) : [],
      pairing: pairing.view() };
  }

  async function startNearby() {
    const settings = store().setting('nearby');
    if (!settings) return;
    const device = await identity();
    presence.browse(device.fingerprint);
    if (coordinator) presence.advertise({ name: settings.name, port: coordinator.server.address.port, fingerprint: device.fingerprint });
    else presence.stopAdvertising();
  }

  function stopNearby() {
    pairing.close();
    presence.stop();
    if (port.configured()) store().setSetting('nearby', null);
  }

  // Turns nearby pairing on: advertise, list the others, and listen for a
  // pairing request. A computer not yet paired opens its own listener for it.
  async function nearbyOn({ name } = {}) {
    const previous = store().setting('nearby');
    const chosen = cleanName(name) || previous?.name || cleanName(hostname()) || 'FULI';
    const opened = !store().setting('membership');
    if (opened) {
      if (store().setting('pendingLeave')) throw new PeerError('leave_pending', 'The previous coordinator is offline. Retry after it is available, or revoke this device there.', 409);
      await startCoordinator({ host: nearbyListenHost, port: 0, name: chosen });
    }
    store().setSetting('nearby', { name: chosen, openedListener: opened || Boolean(previous?.openedListener) });
    if (opened) await startRunner();
    await startNearby();
    return status();
  }

  // Stops advertising and listing. A listener nearby pairing opened, with no
  // device paired through it, closes too, so nothing listens while off.
  async function nearbyOff() {
    const settings = port.configured() ? store().setting('nearby') : null;
    stopNearby();
    if (settings?.openedListener && store().setting('membership')?.role === 'coordinator' && !coordinatesOthers()) return disable();
    return status();
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
    pairing.close();
    presence.stop();
    await stopAll();
  }

  return { resume, status, enableCoordinator, createInvitation, previewInvitation, join, setShares, revokeDevice, disable,
    nearbyOn, nearbyOff, pairNearby, confirmPairing, cancelPairing, publish, close, runnerActive: () => Boolean(runner) };
}

// One project's own repository addresses (host Project.repositories) as
// short digests; the same address on two computers gives the same digest.
function projectDigests(project) {
  return (project.repositories ?? []).map((key) => sha256Hex(`fuli-repository:${key}`).slice(0, 32));
}
