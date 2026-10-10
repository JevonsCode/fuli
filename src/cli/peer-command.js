import { readFileSync } from 'node:fs';

import { resolveSetupPaths } from '../setup/paths.js';
import { DEFAULT_RUNTIME_SETTINGS, readRuntimeSettings } from '../system/runtime-settings.js';
import { shortFingerprint } from '../agent-peer/protocol.js';

const USAGE = `fuli peer <action>  (LAN roundtable Beta; the local console must be running)
  status
  host --address IP [--port PORT] [--name NAME]   turn this computer into the coordinator
  invite                                          print a one-use pairing invitation (10 minutes)
  join (--invitation TEXT | --invitation-file FILE) [--name NAME]
  share --project ID --clients codex[,claude_code] [--folder DIR]   (repeat --project for more; replaces the list)
  revoke --device FINGERPRINT                     coordinator only
  off                                             leave: stop listening, sharing and trusting devices`;

// The owner's LAN roundtable controls through the local console, so the CLI
// and Settings share one runtime and one set of local-only checks.
export async function runPeerCommand(args, { env = process.env, fetchImpl = fetch, write = console.log } = {}) {
  const [action, ...rest] = args;
  if (!action || action === '--help' || action === '-h') { write(USAGE); return; }
  const paths = resolveSetupPaths({ dataDir: option(rest, '--data-dir'), env });
  const settings = paths.runtimeSettingsPath ? readRuntimeSettings(paths.runtimeSettingsPath) : DEFAULT_RUNTIME_SETTINGS;
  const base = `http://127.0.0.1:${settings.ports.console}`;
  const call = async (method, path, body) => {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, { method, headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch {
      throw new Error('The local FULI console is not running; start it with `fuli start`.');
    }
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(value.message ?? `Request failed (${response.status})`);
    return value;
  };
  switch (action) {
    case 'status': return printStatus(await call('GET', '/api/peer'), write);
    case 'host': {
      const address = option(rest, '--address');
      if (!address) throw new Error('Pass --address with one of this computer\'s LAN addresses (see `fuli peer status`).');
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
      if (!/^[0-9a-f]{64}$/.test(device ?? '')) throw new Error('Pass --device with the full fingerprint from `fuli peer status`.');
      return printStatus(await call('POST', `/api/peer/devices/${device}/revoke`, {}), write);
    }
    case 'off': return printStatus(await call('POST', '/api/peer/disable', {}), write);
    default: throw new Error(`Unknown peer action: ${action}\n${USAGE}`);
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
  for (const device of status.devices.filter((entry) => !entry.self)) {
    write(`  device ${device.name} ${device.shortFingerprint} ${device.status}${device.online ? ' online' : ''} ${device.nodeId}`);
  }
  for (const share of status.shares) {
    write(`  shared project lead: ${share.projectName} · ${share.clients.join(', ')} · ${share.state}${share.workingDirectory ? '' : ' · folder from recent sessions'}`);
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : undefined;
}

function options(args, name) {
  return args.flatMap((value, index) => (value === name && index + 1 < args.length ? [args[index + 1]] : []));
}
