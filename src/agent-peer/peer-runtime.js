import { networkInterfaces } from 'node:os';
import { join as joinPath } from 'node:path';

import { resolvePersonalProjectPath } from '../graphiti/project-path-context.js';
import { loadProjectTeam } from '../graphiti/project-team-view.js';
import { startCoordinatorServer } from './coordinator-http.js';
import { cleanName, createCoordinatorService } from './coordinator-service.js';
import { createCoordinatorStore } from './coordinator-store.js';
import { loadDeviceIdentity } from './device-identity.js';
import { createPeerClient, pairWithCoordinator } from './peer-transport.js';
import { coordinatorUrl, decodeInvitation, PeerError, shortFingerprint } from './protocol.js';
import { createPeerRunner } from './runner.js';

const PUBLISH_MS = 60_000;
const WAKE_CLIENTS = new Set(['codex', 'claude_code']);

// The local owner's LAN roundtable controls, run only by the console process.
// Nothing here starts unless the owner turned it on; console LAN access does not.
export function createPeerRuntime({ app, port, interfaces = networkInterfaces, allowLoopback = false,
  claimWaitMs, resolveFolder = resolvePersonalProjectPath, onError = () => {} }) {
  const store = () => port.nodeStore();
  let coordinator = null;
  let runner = null;
  let runnerClient = null;
  let publisher = null;
  let leaveRetry = null;
  let leaveWork = null;
  let leaveAbort = null;
  const spaceId = () => app.config.personal.spaceId;

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
  }

  async function startCoordinator({ host, port: listenPort, name }) {
    const identity = await loadDeviceIdentity(port.directory);
    const authority = await port.localAuthority();
    const coordinatorStore = createCoordinatorStore(joinPath(port.directory, 'coordinator.sqlite'));
    let server = null;
    const service = createCoordinatorService({ store: coordinatorStore, identity, authority, name,
      onTrustChange: () => server?.refreshTrust() });
    try {
      server = await startCoordinatorServer({ service, identity, host, port: listenPort, claimWaitMs });
    } catch (error) {
      coordinatorStore.close();
      throw new PeerError('listen_failed', `Could not listen on ${host}:${listenPort}: ${error.code ?? error.message}`, 409);
    }
    coordinator = { service, server, store: coordinatorStore, host, name };
    const url = coordinatorUrl(host, server.address.port);
    store().setSetting('coordinator', { host, port: server.address.port, name });
    store().setSetting('membership', { role: 'coordinator', coordinator: { url, certPem: identity.certPem,
      fingerprint: identity.fingerprint, name } });
    store().forgetAuthority(identity.fingerprint);
    store().bindAuthority(identity.fingerprint, authority, 'self');
  }

  async function startRunner() {
    if (runner) return;
    const membership = store().setting('membership');
    const identity = await loadDeviceIdentity(port.directory);
    runnerClient = createPeerClient({ identity, coordinator: membership.coordinator });
    runner = createPeerRunner({ store: store(), client: runnerClient, roundtable: app.roundtable, provider: app.personal,
      nodeId: identity.fingerprint, spaceId, onError });
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
  // is withheld until the owner shares the project's new lead.
  async function shareStates() {
    const projects = await app.personal.listPersonalProjects(spaceId()).catch(() => []);
    const names = new Map((Array.isArray(projects) ? projects : projects?.projects ?? [])
      .map((project) => [project.project_id ?? project.personal_project_id ?? project.id, project.profile?.name ?? project.name]));
    return Promise.all(store().shares().filter((share) => share.spaceId === spaceId()).map(async (share) => {
      const team = await loadProjectTeam(app, share.spaceId, share.projectId).catch(() => null);
      const current = team?.lead?.agentId === share.agentId;
      return { ...share, projectName: names.get(share.projectId) ?? share.projectId, lead: team?.lead ?? null,
        state: current ? 'shared' : team?.lead ? 'lead_changed' : 'lead_unavailable' };
    }));
  }

  async function publish() {
    if (!runnerClient) return;
    const agents = (await shareStates()).filter((share) => share.state === 'shared').map((share) => ({
      bindingId: share.bindingId, agentId: share.agentId, name: share.lead.name, employeeNumber: share.lead.employeeNumber,
      responsibility: share.lead.responsibility, projectName: share.projectName, clients: share.clients }));
    await runner?.reconcileShares(new Set(agents.map((agent) => agent.bindingId)));
    await runnerClient.post('/peer/1/directory/publish', { agents });
  }

  // Projects the owner may share: each with its current lead and the clients that lead may use.
  async function shareable() {
    const projects = await app.personal.listPersonalProjects(spaceId()).catch(() => []);
    const list = (Array.isArray(projects) ? projects : projects?.projects ?? [])
      .filter((project) => project.scope_type !== 'temporary').slice(0, 50);
    const agents = await app.listProjectAgents({ personalSpaceId: spaceId() }).catch(() => []);
    return Promise.all(list.map(async (project) => {
      const projectId = project.project_id ?? project.personal_project_id ?? project.id;
      const team = await loadProjectTeam(app, spaceId(), projectId).catch(() => null);
      const allowed = (agents.find((agent) => agent.agentId === team?.lead?.agentId)?.profile.allowedClients ?? [])
        .filter((client) => WAKE_CLIENTS.has(client));
      return { projectId, projectName: project.profile?.name ?? project.name ?? projectId,
        lead: team?.lead ? { agentId: team.lead.agentId, name: team.lead.name } : null, clients: allowed };
    }));
  }

  async function status() {
    if (!port.configured()) {
      return { beta: true, role: null, device: null, coordinator: null, addresses: localAddresses(), devices: [],
        openInvitations: 0, shares: [], shareable: [] };
    }
    const membership = store().setting('membership');
    const identity = membership ? await loadDeviceIdentity(port.directory) : null;
    let devices = [];
    if (coordinator) devices = coordinator.service.devices();
    return {
      beta: true,
      remoteRemovalPending: Boolean(store().setting('pendingLeave')),
      role: membership?.role ?? null,
      device: identity ? { fingerprint: identity.fingerprint, shortFingerprint: shortFingerprint(identity.fingerprint) } : null,
      coordinator: membership ? { name: membership.coordinator.name, url: membership.coordinator.url,
        shortFingerprint: shortFingerprint(membership.coordinator.fingerprint), listening: Boolean(coordinator) } : null,
      addresses: localAddresses(),
      devices: devices.map((device) => ({ ...device, shortFingerprint: shortFingerprint(device.nodeId) })),
      openInvitations: coordinator ? coordinator.service.openInvitations() : 0,
      shares: membership ? (await shareStates()).map(({ lead: _lead, ...share }) => share) : [],
      shareable: membership ? await shareable() : [],
    };
  }

  async function enableCoordinator({ host, port: listenPort = 0, name }) {
    if (store().setting('membership')) throw new PeerError('already_paired', 'Turn the LAN roundtable off before changing its role', 409);
    const allowed = localAddresses();
    if (!(allowed.includes(host) || (allowLoopback && host === '127.0.0.1'))) {
      throw new PeerError('invalid_address', 'Choose one of this computer\'s network addresses', 422);
    }
    if (!Number.isSafeInteger(listenPort) || listenPort < 0 || listenPort > 65535) throw new PeerError('invalid_address', 'Invalid port', 422);
    await startCoordinator({ host, port: listenPort, name: cleanName(name) || 'FULI coordinator' });
    await startRunner();
    return status();
  }

  function createInvitation() {
    if (!coordinator) throw new PeerError('not_coordinator', 'Only the coordinator device creates invitations', 409);
    const settings = store().setting('coordinator');
    return coordinator.service.createInvitation({ url: coordinatorUrl(settings.host, settings.port) });
  }

  function previewInvitation(text) {
    const invitation = decodeInvitation(text);
    return { name: invitation.name, url: invitation.url, fingerprint: invitation.fingerprint,
      shortFingerprint: shortFingerprint(invitation.fingerprint), expiresAt: invitation.expiresAt };
  }

  async function join({ invitation: text, name }) {
    if (store().setting('membership')) throw new PeerError('already_paired', 'This device is already paired', 409);
    await finishLeaving();
    if (store().setting('pendingLeave')) throw new PeerError('leave_pending', 'The previous coordinator is offline. Retry after it is available, or revoke this device there.', 409);
    const invitation = decodeInvitation(text);
    const identity = await loadDeviceIdentity(port.directory);
    const authority = await port.localAuthority();
    const result = await pairWithCoordinator({ identity, authority, invitation, name: cleanName(name) || 'FULI device' });
    if (result.coordinatorNodeId !== invitation.fingerprint) throw new PeerError('invalid_pairing', 'The coordinator answered with another identity', 502);
    store().forgetAuthority(invitation.fingerprint);
    store().bindAuthority(invitation.fingerprint, invitation.authority, 'pairing');
    store().setSetting('membership', { role: 'member', coordinator: { url: invitation.url, certPem: invitation.certificatePem,
      fingerprint: invitation.fingerprint, name: invitation.name || 'FULI coordinator' } });
    await startRunner();
    return status();
  }

  // The owner picks each project, the clients it may be woken in and,
  // optionally, its folder; each share is bound to that project's current lead.
  async function setShares({ shares: wanted }) {
    if (!Array.isArray(wanted) || wanted.length > 50) throw new PeerError('invalid_shares', 'Choose up to 50 projects', 422);
    const projects = await app.personal.listPersonalProjects(spaceId());
    const known = Array.isArray(projects) ? projects : projects?.projects ?? [];
    const agents = await app.listProjectAgents({ personalSpaceId: spaceId() });
    const shares = [];
    for (const entry of wanted) {
      const projectId = entry?.projectId;
      if (typeof projectId !== 'string' || !projectId || shares.some((share) => share.projectId === projectId)) {
        throw new PeerError('invalid_shares', 'Each shared project must be listed once', 422);
      }
      const team = await loadProjectTeam(app, spaceId(), projectId);
      if (!team.lead) throw new PeerError('lead_unavailable', 'A shared project needs an active project lead', 409);
      const allowed = (agents.find((agent) => agent.agentId === team.lead.agentId)?.profile.allowedClients ?? [])
        .filter((client) => WAKE_CLIENTS.has(client));
      const clients = Array.isArray(entry.clients) ? [...new Set(entry.clients)] : [];
      if (!clients.length || !clients.every((client) => allowed.includes(client))) {
        throw new PeerError('invalid_clients', 'Choose at least one client the project lead may use', 422);
      }
      shares.push({ spaceId: spaceId(), projectId, agentId: team.lead.agentId, clients,
        workingDirectory: entry.workingDirectory ? confirmedFolder(entry.workingDirectory, projectId, known) : null });
    }
    store().replaceShares(shares, port.idFactory);
    await runner?.reconcileShares();
    await publish().catch(onError);
    return status();
  }

  // A folder is accepted only when FULI's own project resolution maps it to this project.
  function confirmedFolder(folder, projectId, projects) {
    let resolved;
    try { resolved = resolveFolder(folder, projects); }
    catch { throw new PeerError('invalid_folder', 'Choose an existing folder of this project', 422); }
    if (resolved.personalProjectId !== projectId) {
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

  // Leaves the LAN roundtable. History stays; trust, sharing and listening end.
  async function disable() {
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
    const identity = await loadDeviceIdentity(port.directory);
    const client = createPeerClient({ identity, coordinator: previous });
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

  return { resume, status, enableCoordinator, createInvitation, previewInvitation, join, setShares, revokeDevice, disable,
    publish, close: stopAll, runnerActive: () => Boolean(runner) };
}
