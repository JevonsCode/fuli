import { readFileSync } from 'node:fs';

import { shortFingerprint } from './protocol.js';

export function peerUsage(command) {
  return `${command} peer <action>  (LAN roundtable Beta; the local service must be running)
  status
  nearby [on [--name NAME] | off | clear-attempts] list nearby FULI; on: be seen and listen for pairing
  pair FINGERPRINT                                pair with a nearby FULI (first 4+ characters from the list)
  confirm CODE                                    the 6 digits the person reads on the OTHER computer
  cancel                                          cancel the pairing waiting here
  host --address IP [--port PORT] [--name NAME]   turn this computer into the coordinator
  invite                                          print a one-use pairing invitation (10 minutes)
  join (--invitation TEXT | --invitation-file FILE) [--name NAME]
  share --project ID --clients codex[,claude_code] [--folder DIR]   (repeat --project for more; replaces the list)
  revoke --device FINGERPRINT                     coordinator only
  off                                             leave: stop listening, sharing and trusting devices`;
}

// The owner's LAN roundtable controls through the host's local service, so the
// CLI and any settings page share one runtime and one set of local-only checks.
export async function runPeerControlCommand(args, { baseUrl, command, notRunning, fetchImpl = fetch, write = console.log }) {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === '-h') { write(peerUsage(command)); return; }
  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl()}${path}`, { method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new Error(notRunning);
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.message ?? `Request failed (${response.status})`);
    return value;
  };
  switch (action) {
    case 'status': return printStatus(await call('GET', '/api/peer'), write);
    case 'nearby': {
      const [toggle] = positional(rest);
      if (toggle === 'on') return printNearby(await call('POST', '/api/peer/nearby', { on: true, name: option(rest, '--name') }), write, command);
      if (toggle === 'off') return printNearby(await call('POST', '/api/peer/nearby', { on: false }), write, command);
      if (toggle === 'clear-attempts') return printNearby(await call('POST', '/api/peer/nearby/attempts/clear', {}), write, command);
      if (toggle) throw new Error(`Unknown nearby action: ${toggle}\n${peerUsage(command)}`);
      return printNearby(await call('GET', '/api/peer'), write, command);
    }
    case 'pair': {
      const [fingerprint] = positional(rest);
      if (!fingerprint) throw new Error(`Pass the fingerprint of a computer from \`${command} peer nearby\`.`);
      return printNearby(await call('POST', '/api/peer/nearby/pair', { fingerprint }), write, command);
    }
    case 'confirm': {
      const code = positional(rest).join('');
      if (!/^\d{6}$/.test(code)) throw new Error('Pass the 6-digit code shown on the other computer.');
      const pairing = (await call('GET', '/api/peer')).nearby?.pairing;
      if (!pairing?.requestId || pairing.state !== 'confirm') throw new Error('No pairing is waiting for confirmation here.');
      return printNearby(await call('POST', '/api/peer/nearby/confirm', { requestId: pairing.requestId, code }), write, command);
    }
    case 'cancel': return printNearby(await call('POST', '/api/peer/nearby/cancel', {}), write, command);
    case 'host': {
      const address = option(rest, '--address');
      if (!address) throw new Error(`Pass --address with one of this computer's LAN addresses (see \`${command} peer status\`).`);
      return printStatus(await call('POST', '/api/peer/coordinator', { host: address,
        port: Number(option(rest, '--port') ?? 0), name: option(rest, '--name') }), write);
    }
    case 'invite': {
      const result = await call('POST', '/api/peer/invitations', {});
      write(`Coordinator fingerprint: ${shortFingerprint(result.fingerprint)}`);
      write(`Invitation (one use, until ${result.expiresAt}):\n${result.invitation}`);
      write('Compare this fingerprint with the one shown on the joining device before you share it.');
      return;
    }
    case 'join': {
      const file = option(rest, '--invitation-file');
      const invitation = option(rest, '--invitation') ?? (file ? readFileSync(file, 'utf8').trim() : null);
      if (!invitation) throw new Error('Pass --invitation or --invitation-file.');
      return printStatus(await call('POST', '/api/peer/join', { invitation, name: option(rest, '--name') }), write);
    }
    case 'share': {
      const projects = options(rest, '--project');
      const clients = (option(rest, '--clients') ?? '').split(',').map((client) => client.trim()).filter(Boolean);
      const folder = option(rest, '--folder');
      if (projects.length > 1 && folder) throw new Error('--folder applies to a single --project.');
      return printStatus(await call('PUT', '/api/peer/shares', { shares: projects.map((projectId) => ({ projectId, clients,
        ...(folder ? { workingDirectory: folder } : {}) })) }), write);
    }
    case 'revoke': {
      const device = option(rest, '--device');
      if (!/^[0-9a-f]{64}$/.test(device ?? '')) throw new Error(`Pass --device with the full fingerprint from \`${command} peer status\`.`);
      return printStatus(await call('POST', `/api/peer/devices/${device}/revoke`, {}), write);
    }
    case 'off': return printStatus(await call('POST', '/api/peer/disable', {}), write);
    default: throw new Error(`Unknown peer action: ${action}\n${peerUsage(command)}`);
  }
}

function printStatus(status, write) {
  if (!status.role) {
    write('LAN roundtable (Beta): off.');
    if (status.remoteRemovalPending) write('This device has stopped sharing. Pairing removal will retry when the coordinator is available.');
    if (status.addresses.length) write(`LAN addresses: ${status.addresses.join(', ')}`);
    return;
  }
  write(`LAN roundtable (Beta): ${status.role === 'coordinator' ? 'coordinator' : 'paired device'}`);
  write(`This device: ${status.device.shortFingerprint}`);
  write(`Coordinator: ${status.coordinator.name} ${status.coordinator.url} (${status.coordinator.shortFingerprint})`);
  const failure = status.coordinator.listenFailure;
  if (failure) write(`Not listening: could not open ${failure.address}:${failure.port} (${failure.code}). Paired devices cannot reach this computer; turn the LAN roundtable off and on again.`);
  for (const device of status.devices.filter((entry) => !entry.self)) {
    write(`  device ${device.name} ${device.shortFingerprint} ${device.status}${device.online ? ' online' : ''} · shared Agents ${device.sharedAgents} · ${device.nodeId}`);
  }
  for (const share of status.shares) {
    write(`  shared project lead: ${share.projectName} · ${share.clients.join(', ')} · ${share.state}${share.reason ? ` (${share.reason})` : ''}${share.workingDirectory ? '' : ' · folder from recent sessions'}`);
  }
  for (const project of status.shareable.filter((entry) => entry.sameProjectOn?.length)) {
    write(`  same project on ${project.sameProjectOn.map((device) => device.name).join(', ')}: ${project.projectName} (${project.projectId})${project.knownFolder ? '' : ' · no known folder here, pass --folder'}`);
  }
  if (status.lastPublish?.error) write(`The coordinator did not get this device's shared list: ${status.lastPublish.error}. ${status.lastPublish.message ?? ''}`.trim());
  else if (status.lastPublish) write(`Shared list sent to the coordinator: ${status.lastPublish.agents} Agent(s) at ${status.lastPublish.at}`);
}

function printNearby(status, write, command) {
  const { nearby } = status;
  const ended = NEARBY_ENDED[nearby.ended?.kind];
  if (ended) write(ended(nearby.ended));
  if (!nearby.on) {
    write(`Nearby pairing: off. \`${command} peer nearby on [--name NAME]\` lets computers on this network see that this one runs FULI (for 30 minutes).`);
    return;
  }
  write(`Nearby pairing: on until ${nearby.until}, seen as "${nearby.name}"${nearby.reason ? ` (${nearby.reason})` : ''}`);
  const tried = nearby.attempts;
  if (nearby.limited) write(`Too many pairing attempts (${tried.lastWindow} in 10 minutes, ${tried.lastDay} in 24 hours). Wait, or the person on this computer runs \`${command} peer nearby clear-attempts\`.`);
  else if (tried?.lastDay) write(`Pairing attempts: ${tried.lastWindow} in the last 10 minutes, ${tried.lastDay} in 24 hours.`);
  if (!nearby.devices.length) write('  No other FULI seen on this network yet.');
  for (const device of nearby.devices) write(`  ${device.name} · ${device.shortFingerprint}${device.paired ? ' · paired' : ''}`);
  const { pairing } = nearby;
  if (!pairing) return;
  const device = `${pairing.device.name} (${pairing.device.shortFingerprint ?? '…'})`;
  if (pairing.direction === 'incoming' && pairing.state === 'connecting') {
    write(`${device} asks to pair with this computer. \`${command} peer cancel\` refuses it.`);
  } else if (pairing.state === 'confirm' || pairing.state === 'finishing') {
    write(`Pairing with ${device}: code ${pairing.code}. ${pairing.coordinator === 'this' ? 'This computer' : 'The other computer'} will coordinate.`);
    write(pairing.confirmedHere
      ? `Confirmed here; waiting for the person on the other computer${pairing.confirmedThere ? ' (confirmed there too, finishing)' : ''}.`
      : `Compare it with the code on the other computer; if they match, run \`${command} peer confirm <the code shown there>\` before ${pairing.expiresAt}.`);
  } else write(`Pairing with ${device}: ${pairing.state}${pairing.reason ? ` (${pairing.reason})` : ''}`);
}

// Why nearby pairing turned itself off, or what it last did.
const NEARBY_ENDED = {
  paired: (ended) => `Paired with ${ended.name}; nearby pairing turned itself off.`,
  timeout: () => 'Nearby pairing turned itself off after 30 minutes.',
  discovery_failed: (ended) => `Nearby discovery could not start: ${ended.reason}. Nearby pairing is off; the rest keeps running.`,
  trust_withdrawn: (ended) => `${ended.name} never connected after pairing, so this computer no longer trusts it.`,
};

// The words before the first --option.
function positional(args) {
  const first = args.findIndex((value) => value.startsWith('--'));
  return first < 0 ? args : args.slice(0, first);
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function options(args, name) {
  return args.flatMap((value, index) => (value === name && index + 1 < args.length ? [args[index + 1]] : []));
}
