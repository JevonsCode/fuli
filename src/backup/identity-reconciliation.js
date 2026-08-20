import { chmodSync } from 'node:fs';

import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';
import {
  managedProviderUrls,
  readRuntimeSettings
} from '../system/runtime-settings.js';

const PROVIDER_READY_ATTEMPTS = 120;

export function graphBackupSelection(paths, {
  readConfig = (path) => readJsonFile(path, null)
} = {}) {
  const config = readConfig(paths.graphRuntimeConfigPath);
  const personalSpaceId = nonEmpty(config?.personal?.spaceId);
  return personalSpaceId ? { personalSpaceId } : null;
}

export async function reconcileImportedGraphIdentity({
  paths,
  instances,
  selection = {},
  sourceMode,
  targetMode,
  fetchImpl = globalThis.fetch,
  wait = delay,
  readConfig = (path) => readJsonFile(path, null),
  writeConfig = writeJsonFileAtomic,
  secureConfig = (path) => chmodSync(path, 0o600),
  readSettings = readRuntimeSettings,
  readEnvironment = readEnvironmentFile
}) {
  const current = readConfig(paths.graphRuntimeConfigPath);
  if (!current?.personal) {
    throw new Error('The target graph mode is not configured. Run setup before importing.');
  }
  const settings = readSettings(paths.runtimeSettingsPath);
  const urls = managedProviderUrls(settings);
  const values = await readEnvironment(paths.graphEnvPath);
  const sourceConfigPath = profilePath(paths, sourceMode);
  const source = sourceMode === targetMode || !sourceConfigPath
    ? null
    : readConfig(sourceConfigPath);
  const next = structuredClone(current);
  next.workspaces = mergedExternalWorkspaces(current, source);

  await waitForProvider(urls.personal, fetchImpl, wait);
  const personal = await bootstrapProvider({
    url: urls.personal,
    bootstrapToken: requiredValue(values, 'FULI_PERSONAL_BOOTSTRAP_TOKEN'),
    fetchImpl
  });
  const spaces = await listSpaces(urls.personal, personal.accessToken, fetchImpl);
  const personalSpaceId = selectPersonalSpace({
    spaces,
    requestedId: selection.personalSpaceId,
    currentId: source?.personal?.spaceId ?? current.personal.spaceId
  });
  next.personal = {
    ...next.personal,
    providerUrl: urls.personal,
    accessToken: personal.accessToken,
    principalId: personal.principalId,
    spaceId: personalSpaceId,
    ...(nonEmpty(values.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN)
      ? { workflowObservationToken: values.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN }
      : {})
  };

  if (instances.includes('workspace')) {
    await waitForProvider(urls.workspace, fetchImpl, wait);
    const workspace = await bootstrapProvider({
      url: urls.workspace,
      bootstrapToken: requiredValue(values, 'FULI_WORKSPACE_BOOTSTRAP_TOKEN'),
      fetchImpl
    });
    next.workspaces.push({
      providerUrl: urls.workspace,
      accessToken: workspace.accessToken,
      principalId: workspace.principalId,
      managedDevelopment: true
    });
  }

  try {
    writeConfig(paths.graphRuntimeConfigPath, next);
    secureConfig(paths.graphRuntimeConfigPath);
  } catch (error) {
    try {
      writeConfig(paths.graphRuntimeConfigPath, current);
      secureConfig(paths.graphRuntimeConfigPath);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        'Imported graph credentials could not be saved or restored.'
      );
    }
    throw error;
  }
  return { personalSpaceId, instances: [...instances] };
}

async function waitForProvider(url, fetchImpl, wait) {
  for (let attempt = 0; attempt < PROVIDER_READY_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(`${url}/health`, {
        signal: AbortSignal.timeout(2500)
      });
      if (response.ok) return;
    } catch {
      // The target is still starting.
    }
    if (attempt < PROVIDER_READY_ATTEMPTS - 1) await wait(1000);
  }
  throw new Error('The imported graph Provider did not become ready for credential rotation.');
}

async function bootstrapProvider({ url, bootstrapToken, fetchImpl }) {
  const response = await fetchImpl(`${url}/v1/bootstrap`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-fuli-bootstrap-token': bootstrapToken
    },
    body: JSON.stringify({ principal_name: 'Fuli migration' }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('The imported graph Provider rejected credential rotation.');
  const body = await response.json();
  const principalId = nonEmpty(body?.principal_id);
  const accessToken = nonEmpty(body?.access_token);
  if (!principalId || !accessToken) {
    throw new Error('The imported graph Provider returned an invalid bootstrap identity.');
  }
  return { principalId, accessToken };
}

async function listSpaces(url, accessToken, fetchImpl) {
  const response = await fetchImpl(`${url}/v1/spaces`, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error('The imported graph Provider could not list personal spaces.');
  const body = await response.json();
  if (!Array.isArray(body)) throw new Error('The imported graph Provider returned invalid spaces.');
  return body.filter((space) => space?.kind === 'personal' && nonEmpty(space.id));
}

function selectPersonalSpace({ spaces, requestedId, currentId }) {
  for (const candidate of [requestedId, currentId]) {
    const id = nonEmpty(candidate);
    if (id && spaces.some((space) => space.id === id)) return id;
  }
  if (spaces.length === 1) return spaces[0].id;
  throw new Error(
    'The imported graph contains multiple personal spaces and the backup does not select one.'
  );
}

function mergedExternalWorkspaces(current, source) {
  const result = new Map();
  for (const workspace of [
    ...(source?.workspaces ?? []),
    ...(current?.workspaces ?? [])
  ]) {
    if (isManagedWorkspace(workspace)) continue;
    const providerUrl = nonEmpty(workspace?.providerUrl);
    if (providerUrl) result.set(providerUrl, structuredClone(workspace));
  }
  return [...result.values()];
}

function isManagedWorkspace(workspace) {
  return workspace?.managedDevelopment === true;
}

function profilePath(paths, mode) {
  if (mode === 'container') return paths.containerGraphConfigProfilePath;
  if (mode === 'native') return paths.nativeGraphConfigProfilePath;
  return null;
}

async function readEnvironmentFile(path) {
  const { readFile } = await import('node:fs/promises');
  const body = await readFile(path, 'utf8');
  const values = {};
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator > 0) values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

function requiredValue(values, name) {
  const value = nonEmpty(values[name]);
  if (!value) throw new Error(`The target graph environment is missing ${name}.`);
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
