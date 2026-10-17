import { setTimeout as delay } from 'node:timers/promises';

import { readJsonFile } from '../storage/json-file.js';
import { createNativeGraphServices } from '../native-runtime/runtime.js';
import {
  ensureContainerRuntime,
  inspectContainerRuntime,
  runDockerCompose
} from '../setup/container-runtime.js';
import {
  DEFAULT_RUNTIME_SETTINGS,
  managedProviderUrls,
  readRuntimeSettings
} from '../system/runtime-settings.js';
import { isManagedWorkspace, waitForProviderHealth } from '../local-runtime/provider-readiness.js';

const PERSONAL_SERVICES = Object.freeze({
  providers: ['personal-provider'],
  databases: ['personal-neo4j']
});
const WORKSPACE_SERVICES = Object.freeze({
  providers: ['workspace-provider'],
  databases: ['workspace-neo4j']
});

export function createGraphServices({
  paths,
  readSettings = readRuntimeSettings,
  createContainerServices = createManagedGraphServices,
  createNativeServices = createNativeGraphServices
}) {
  const settings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  return settings.graphRuntimeMode === 'native'
    ? createNativeServices({ paths })
    : createContainerServices({ paths });
}

export function createManagedGraphServices({
  paths,
  readJson = readJsonFile,
  readSettings = readRuntimeSettings,
  ensureRuntime = ensureContainerRuntime,
  inspectRuntime = inspectContainerRuntime,
  runCompose = runDockerCompose,
  fetchImpl = globalThis.fetch,
  wait = delay,
  onProgress = () => {}
}) {
  let containerRuntime = null;

  async function runtime() {
    if (containerRuntime?.status === 'ready') return containerRuntime;
    containerRuntime = await ensureRuntime({ onProgress });
    return containerRuntime;
  }

  function managedServices() {
    const state = readJson(paths.graphRuntimeStatePath, null);
    const config = readJson(paths.graphRuntimeConfigPath, null);
    const workspace = state?.managedProviders?.includes('development-workspace') ||
      (config?.workspaces ?? []).some(isManagedWorkspace);
    return {
      providers: [
        ...PERSONAL_SERVICES.providers,
        ...(workspace ? WORKSPACE_SERVICES.providers : [])
      ],
      databases: [
        ...PERSONAL_SERVICES.databases,
        ...(workspace ? WORKSPACE_SERVICES.databases : [])
      ],
      providerUrls: providerUrls(config, paths, readSettings, workspace)
    };
  }

  async function start() {
    const services = managedServices();
    compose([
      'up', '-d', '--no-build',
      ...services.databases,
      ...services.providers
    ], await runtime());
    for (const url of services.providerUrls) await waitForProviderHealth(url, {
      fetchImpl,
      wait,
      failureMessage: 'The managed graph Provider did not become ready after waking'
    });
  }

  async function stopProviders() {
    const selectedRuntime = inspectRuntime();
    if (selectedRuntime.status === 'stopped') return;
    const services = managedServices();
    compose(['stop', '-t', '20', ...services.providers], selectedRuntime);
  }

  async function stopDatabases() {
    // Inspect only: shutdown must not launch a desktop container engine to stop it.
    const selectedRuntime = inspectRuntime();
    if (selectedRuntime.status === 'stopped') return;
    const services = managedServices();
    // Keep shutdown ordering explicit even if an external action restarted a Provider.
    compose(['stop', '-t', '20', ...services.providers], selectedRuntime);
    compose(['stop', '-t', '20', ...services.databases], selectedRuntime);
  }

  async function ready() {
    const services = managedServices();
    const checks = await Promise.all(services.providerUrls.map((url) =>
      providerReady(url, fetchImpl)));
    return checks.every(Boolean);
  }

  function compose(action, selectedRuntime) {
    runCompose([
      'compose',
      '--env-file', paths.graphEnvPath,
      '-f', paths.graphComposePath,
      ...action
    ], selectedRuntime);
  }

  return { start, stopProviders, stopDatabases, ready };
}

function providerUrls(config, paths, readSettings, includesWorkspace) {
  const settings = paths.runtimeSettingsPath
    ? readSettings(paths.runtimeSettingsPath)
    : DEFAULT_RUNTIME_SETTINGS;
  const defaults = managedProviderUrls(settings);
  const urls = [config?.personal?.providerUrl ?? defaults.personal];
  if (!includesWorkspace) return urls;
  const managed = (config?.workspaces ?? []).find(isManagedWorkspace);
  return [...urls, managed?.providerUrl ?? defaults.workspace];
}

async function providerReady(url, fetchImpl) {
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(2500)
    });
    return response.ok;
  } catch {
    return false;
  }
}
