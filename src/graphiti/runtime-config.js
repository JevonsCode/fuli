import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveSetupPaths } from '../setup/paths.js';

export class GraphRuntimeConfigurationError extends TypeError {}

export function resolveGraphRuntimeOptions(args = [], env = process.env, options = {}) {
  const configuredPath = runtimeValue(args, '--runtime-config') ??
    nonEmpty(env.FULI_GRAPH_RUNTIME_CONFIG);
  const dataDir = resolveSetupPaths({ env, ...options.setupPaths }).dataDir;
  return {
    runtimeConfigPath: resolve(configuredPath ?? join(dataDir, 'graph-runtime.json'))
  };
}

export function readGraphRuntimeConfig(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new GraphRuntimeConfigurationError(
      `Graphiti runtime is not configured. Run: node src/graphiti/setup.js`
    );
  }
  validateConfig(parsed);
  return parsed;
}

function validateConfig(config) {
  if (config?.version !== 1) fail('unsupported graph runtime config version');
  provider(config.personal, 'personal');
  if (!config.personal.spaceId) fail('personal.spaceId is required');
  if (!Array.isArray(config.workspaces)) fail('workspaces must be an array');
  for (const [index, workspace] of config.workspaces.entries()) {
    provider(workspace, `workspaces[${index}]`);
  }
}

function provider(value, label) {
  if (!value || typeof value !== 'object') fail(`${label} is required`);
  for (const property of ['providerUrl', 'accessToken', 'principalId']) {
    if (!nonEmpty(value[property])) fail(`${label}.${property} is required`);
  }
  value.providerUrl = canonicalProviderUrl(value.providerUrl);
}

export function canonicalProviderUrl(value) {
  const normalized = String(value).replace(/\/$/, '');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    fail('provider URL is invalid');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('provider URL must use HTTPS or loopback HTTP');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    fail('provider URL must contain only scheme, host, and optional port');
  }
  return normalized;
}

function runtimeValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!nonEmpty(value) || value.startsWith('--')) {
    throw new GraphRuntimeConfigurationError(`Missing value for ${flag}`);
  }
  if (args.indexOf(flag, index + 1) !== -1) {
    throw new GraphRuntimeConfigurationError(`Duplicate ${flag}`);
  }
  return value;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function fail(message) {
  throw new GraphRuntimeConfigurationError(message);
}
