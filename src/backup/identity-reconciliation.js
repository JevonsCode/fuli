import { chmodSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { readJsonFile } from '../storage/json-file.js';
import { GRAPH_RUNTIME_CONFIG_FORMAT } from '../graphiti/runtime-config.js';
import { assertJsonFormatWritable, requireJsonFormatVersion, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import {
  managedProviderUrls,
  readRuntimeSettings
} from '../system/runtime-settings.js';
import { nonEmptyText } from '../validation/values.js';
import { waitForProviderHealth } from '../local-runtime/provider-readiness.js';

const IMPORTED_PROVIDER_NOT_READY = 'The imported graph Provider did not become ready for credential rotation.';

export function graphBackupSelection(paths, {
  readConfig = (path) => readJsonFile(path, null)
} = {}) {
  const config = readConfig(paths.graphRuntimeConfigPath);
  const personalSpaceId = nonEmptyText(config?.personal?.spaceId);
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
  writeConfig = (path, value) => writeVersionedJsonFileAtomic(path, value, GRAPH_RUNTIME_CONFIG_FORMAT),
  secureConfig = (path) => chmodSync(path, 0o600),
  readSettings = readRuntimeSettings,
  readEnvironment = readEnvironmentFile
}) {
  const current = readConfig(paths.graphRuntimeConfigPath);
  if (!current?.personal) {
    throw new Error('The target graph mode is not configured. Run setup before importing.');
  }
  // Every format is known before a Provider is bootstrapped (rec#17): a config
  // a newer FULI wrote is neither copied nor rewritten by this one.
  assertJsonFormatWritable(paths.graphRuntimeConfigPath, GRAPH_RUNTIME_CONFIG_FORMAT);
  requireJsonFormatVersion(current, GRAPH_RUNTIME_CONFIG_FORMAT);
  const settings = readSettings(paths.runtimeSettingsPath);
  const urls = managedProviderUrls(settings);
  const values = await readEnvironment(paths.graphEnvPath);
  const sourceConfigPath = profilePath(paths, sourceMode);
  const source = sourceMode === targetMode || !sourceConfigPath
    ? null
    : readConfig(sourceConfigPath);
  if (source) requireJsonFormatVersion(source, GRAPH_RUNTIME_CONFIG_FORMAT);
  const next = structuredClone(current);
  next.workspaces = mergedExternalWorkspaces(current, source);

  await waitForProviderHealth(urls.personal, { fetchImpl, wait, failureMessage: IMPORTED_PROVIDER_NOT_READY });
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
    ...(nonEmptyText(values.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN)
      ? { workflowObservationToken: values.FULI_PERSONAL_WORKFLOW_OBSERVATION_TOKEN }
      : {})
  };

  if (instances.includes('workspace')) {
    await waitForProviderHealth(urls.workspace, { fetchImpl, wait, failureMessage: IMPORTED_PROVIDER_NOT_READY });
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
  const principalId = nonEmptyText(body?.principal_id);
  const accessToken = nonEmptyText(body?.access_token);
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
  return body.filter((space) => space?.kind === 'personal' && nonEmptyText(space.id));
}

function selectPersonalSpace({ spaces, requestedId, currentId }) {
  for (const candidate of [requestedId, currentId]) {
    const id = nonEmptyText(candidate);
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
    if (workspace?.managedDevelopment === true) continue;
    const providerUrl = nonEmptyText(workspace?.providerUrl);
    if (providerUrl) result.set(providerUrl, structuredClone(workspace));
  }
  return [...result.values()];
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
  const value = nonEmptyText(values[name]);
  if (!value) throw new Error(`The target graph environment is missing ${name}.`);
  return value;
}
