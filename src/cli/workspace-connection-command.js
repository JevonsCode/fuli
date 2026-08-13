import {
  chmodSync,
  lstatSync,
  readFileSync,
  writeFileSync
} from 'node:fs';

import {
  canonicalProviderUrl,
  GraphRuntimeConfigurationError
} from '../graphiti/runtime-config.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

const HELP_FLAGS = new Set(['--help', '-h']);
const VALUE_FLAGS = new Set(['--url', '--token-file', '--data-dir']);
const WORKSPACE_ROLES = new Set(['reader', 'contributor', 'maintainer', 'admin']);
const MAX_HANDSHAKE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 4096;

export class WorkspaceConnectionError extends Error {}

export async function runWorkspaceConnectionCommand(args, dependencies = {}) {
  const options = parseWorkspaceConnectionOptions(args);
  const write = dependencies.write ?? writeLine;
  if (options.help) {
    write(workspaceConnectionHelp());
    return { status: 'help' };
  }

  const providerUrl = normalizeProviderUrl(options.url);
  const token = readSecureToken(options.tokenFile, dependencies);
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new WorkspaceConnectionError('This Node.js runtime does not provide fetch.');
  }

  const discovery = await requestJson({
    fetchImpl,
    url: new URL('/.well-known/fuli-workspace', `${providerUrl}/`),
    expectedOrigin: new URL(providerUrl).origin,
    timeoutMs: dependencies.timeoutMs
  });
  const provider = validateDiscovery(discovery, providerUrl);
  const session = await requestJson({
    fetchImpl,
    url: provider.authSessionUrl,
    expectedOrigin: new URL(providerUrl).origin,
    token,
    timeoutMs: dependencies.timeoutMs
  });
  const identity = validateSession(session);

  const resolvePaths = dependencies.resolvePaths ?? resolveSetupPaths;
  const paths = resolvePaths({ dataDir: options.dataDir, env: dependencies.env ?? process.env });
  const runtimeConfigPath = paths.graphRuntimeConfigPath;
  const readConfig = dependencies.readConfig ?? readJsonFile;
  let runtimeConfig;
  try {
    runtimeConfig = readConfig(runtimeConfigPath, null);
  } catch {
    throw new WorkspaceConnectionError('Could not read the Fuli runtime configuration.');
  }
  if (runtimeConfig?.version !== 1 || !runtimeConfig.personal
      || !Array.isArray(runtimeConfig.workspaces)) {
    throw new WorkspaceConnectionError('Fuli is not initialized. Run `fuli setup` first.');
  }

  const workspace = {
    protocol: 'fuli-workspace-v1',
    providerUrl,
    providerId: provider.id,
    accessToken: token,
    principalId: identity.principalId,
    role: identity.role,
    workspaceIds: identity.workspaceIds
  };
  const nextConfig = {
    ...runtimeConfig,
    workspaces: upsertWorkspace(runtimeConfig.workspaces, workspace)
  };
  const writeConfig = dependencies.writeConfig ?? writeSecureJson;
  const secureFile = dependencies.secureFile ?? ((path) => chmodSync(path, 0o600));
  try {
    writeConfig(runtimeConfigPath, nextConfig);
    secureFile(runtimeConfigPath);
  } catch {
    throw new WorkspaceConnectionError('Could not update the Fuli runtime configuration.');
  }

  write([
    `Shared workspace service configured: ${providerUrl}`,
    'Restart required: run `fuli restart` to apply this connection.'
  ].join('\n'));
  return { status: 'configured', providerUrl, restartRequired: true };
}

export function parseWorkspaceConnectionOptions(args) {
  if (!Array.isArray(args)) throw new WorkspaceConnectionError('Command arguments are invalid.');
  if (args.some((argument) => HELP_FLAGS.has(argument))) {
    if (args.length !== 1) {
      throw new WorkspaceConnectionError('The help flag cannot be combined with other options.');
    }
    return { help: true, url: null, tokenFile: null, dataDir: null };
  }

  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!VALUE_FLAGS.has(flag)) {
      throw new WorkspaceConnectionError('Unknown option for connect-workspace.');
    }
    if (values.has(flag)) {
      throw new WorkspaceConnectionError(`Duplicate connect-workspace option: ${flag}`);
    }
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new WorkspaceConnectionError(`Missing value for ${flag}`);
    }
    values.set(flag, value.trim());
  }

  if (!values.has('--url')) {
    throw new WorkspaceConnectionError('Missing required option: --url');
  }
  if (!values.has('--token-file')) {
    throw new WorkspaceConnectionError('Missing required option: --token-file');
  }
  return {
    help: false,
    url: values.get('--url'),
    tokenFile: values.get('--token-file'),
    dataDir: values.get('--data-dir') ?? null
  };
}

export function workspaceConnectionHelp() {
  return [
    'Usage: fuli connect-workspace --url URL --token-file FILE [--data-dir DIR]',
    '',
    'Validates a Fuli Workspace service and stores its bearer token in the local',
    'Fuli runtime configuration. Restart Fuli after the command succeeds.'
  ].join('\n');
}

function normalizeProviderUrl(value) {
  try {
    return new URL(canonicalProviderUrl(value)).origin;
  } catch (error) {
    if (error instanceof GraphRuntimeConfigurationError) {
      throw new WorkspaceConnectionError(error.message);
    }
    throw new WorkspaceConnectionError('Workspace service URL is invalid.');
  }
}

function readSecureToken(path, dependencies) {
  const inspect = dependencies.lstat ?? lstatSync;
  const readText = dependencies.readText ?? ((filePath) => readFileSync(filePath, 'utf8'));
  let metadata;
  try {
    metadata = inspect(path);
  } catch {
    throw new WorkspaceConnectionError('The token file could not be inspected.');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new WorkspaceConnectionError('The token file must be a regular file, not a symlink.');
  }
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32' && (metadata.mode & 0o077) !== 0) {
    throw new WorkspaceConnectionError('The token file must not be readable by group or other users.');
  }
  if (!Number.isFinite(metadata.size) || metadata.size < 1 || metadata.size > MAX_TOKEN_BYTES) {
    throw new WorkspaceConnectionError('The token file has an invalid size.');
  }

  let token;
  try {
    token = readText(path).trim();
  } catch {
    throw new WorkspaceConnectionError('The token file could not be read.');
  }
  if (token.length < 20 || token.length > MAX_TOKEN_BYTES || !/^[\x21-\x7e]+$/u.test(token)) {
    throw new WorkspaceConnectionError('The token file does not contain a valid bearer token.');
  }
  return token;
}

async function requestJson({ fetchImpl, url, expectedOrigin, token = null, timeoutMs = 5000 }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new WorkspaceConnectionError('Could not reach the workspace service.');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new WorkspaceConnectionError('Workspace service redirects are not allowed during connection.');
  }
  if (response.url) {
    let responseOrigin;
    try {
      responseOrigin = new URL(response.url).origin;
    } catch {
      throw new WorkspaceConnectionError('Workspace service returned an invalid response URL.');
    }
    if (responseOrigin !== expectedOrigin) {
      throw new WorkspaceConnectionError('Workspace service returned a cross-origin response.');
    }
  }
  if (!response.ok) {
    throw new WorkspaceConnectionError(`Workspace service rejected the connection (HTTP ${response.status}).`);
  }

  let text;
  try {
    text = await response.text();
  } catch {
    throw new WorkspaceConnectionError('Workspace service returned an unreadable response.');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_HANDSHAKE_BYTES) {
    throw new WorkspaceConnectionError('Workspace service response is too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkspaceConnectionError('Workspace service did not return valid JSON.');
  }
}

function validateDiscovery(discovery, providerUrl) {
  if (String(discovery?.protocolVersion ?? '') !== '1') {
    throw new WorkspaceConnectionError('Workspace service protocol version is not supported.');
  }
  const id = safeIdentifier(discovery?.provider?.id, 'Workspace service provider ID is invalid.');
  const advertised = discovery?.endpoints?.authSession ?? '/v1/auth/session';
  const authSessionUrl = sameOriginEndpoint(advertised, providerUrl);
  return { id, authSessionUrl };
}

function validateSession(session) {
  if (session?.authenticated !== true) {
    throw new WorkspaceConnectionError('The workspace service did not authenticate this token.');
  }
  const principalId = safeIdentifier(
    session?.principal?.id,
    'Workspace service returned an invalid principal.'
  );
  const grant = session?.grant && typeof session.grant === 'object' ? session.grant : session;
  const role = String(grant?.role ?? '');
  if (!WORKSPACE_ROLES.has(role)) {
    throw new WorkspaceConnectionError('Workspace service returned an unsupported role.');
  }
  const workspaceIds = normalizeWorkspaceIds(grant?.workspaceIds);
  return { principalId, role, workspaceIds };
}

function normalizeWorkspaceIds(value) {
  if (value === '*') return '*';
  if (!Array.isArray(value)) {
    throw new WorkspaceConnectionError('Workspace service returned an invalid workspace grant.');
  }
  return value.map((id) => safeIdentifier(id, 'Workspace service returned an invalid workspace grant.'));
}

function safeIdentifier(value, message) {
  if (typeof value !== 'string') throw new WorkspaceConnectionError(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new WorkspaceConnectionError(message);
  }
  return normalized;
}

function sameOriginEndpoint(value, providerUrl) {
  let endpoint;
  try {
    endpoint = new URL(String(value), `${providerUrl}/`);
  } catch {
    throw new WorkspaceConnectionError('Workspace service advertised an invalid authentication endpoint.');
  }
  const providerOrigin = new URL(providerUrl).origin;
  if (endpoint.origin !== providerOrigin || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash) {
    throw new WorkspaceConnectionError('Workspace service advertised a cross-origin authentication endpoint.');
  }
  return endpoint;
}

function upsertWorkspace(workspaces, workspace) {
  const next = [];
  let replaced = false;
  for (const existing of workspaces) {
    if (!sameProvider(existing?.providerUrl, workspace.providerUrl)) {
      next.push(existing);
      continue;
    }
    if (!replaced) next.push({ ...existing, ...workspace });
    replaced = true;
  }
  if (!replaced) next.push(workspace);
  return next;
}

function sameProvider(left, right) {
  try {
    return new URL(canonicalProviderUrl(left)).origin === right;
  } catch {
    return false;
  }
}

function writeSecureJson(path, value) {
  writeJsonFileAtomic(path, value, {
    writeFileSync: (temporaryPath, payload, options) => writeFileSync(
      temporaryPath,
      payload,
      { ...options, mode: 0o600 }
    )
  });
}

function writeLine(value) {
  process.stdout.write(`${value}\n`);
}
