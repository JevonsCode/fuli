import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function createCustomConnector({ directory }) {
  const root = realpathSync(requiredString(directory, 'Custom connector directory'));

  async function load(context) {
    const modulePath = connectorModulePath(root, context.config?.module);
    const modified = statSync(modulePath).mtimeMs;
    const namespace = await import(`${pathToFileURL(modulePath).href}?mtime=${modified}`);
    const implementation = namespace.default ?? namespace.connector;
    if (!implementation || typeof implementation !== 'object') {
      throw new TypeError('Custom connector module must export a connector object');
    }
    if (typeof implementation.sync !== 'function' &&
        typeof implementation.retrieve !== 'function') {
      throw new TypeError('Custom connector must implement sync or retrieve');
    }
    return implementation;
  }

  async function invoke(method, context, { optional = false } = {}) {
    const implementation = await load(context);
    if (typeof implementation[method] !== 'function') {
      if (optional) return null;
      throw new TypeError(`Custom connector does not implement ${method}`);
    }
    return implementation[method](customContext(context));
  }

  return {
    type: 'custom',
    name: '自定义代码',
    capabilities: ['discover', 'sync', 'retrieve'],

    async check(context) {
      const implementation = await load(context);
      const capabilities = ['discover', 'sync', 'retrieve']
        .filter((name) => typeof implementation[name] === 'function');
      const result = typeof implementation.check === 'function'
        ? await implementation.check(customContext(context))
        : { status: 'ready' };
      return { ...result, capabilities };
    },

    async discover(context) {
      return await invoke('discover', context, { optional: true }) ?? {
        items: [],
        nextCursor: null,
        hasMore: false
      };
    },

    async sync(context) {
      return invoke('sync', context);
    },

    async retrieve(context) {
      return invoke('retrieve', context);
    }
  };
}

function connectorModulePath(root, value) {
  const name = requiredString(value, 'Custom connector module');
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.m?js$/u.test(name) || name.includes('//')) {
    throw new TypeError('Custom connector module must stay inside the custom connector directory');
  }
  const candidate = resolve(root, name);
  const pathFromRoot = relative(root, candidate);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new TypeError('Custom connector module must stay inside the custom connector directory');
  }
  let actual;
  try {
    actual = realpathSync(candidate);
  } catch {
    throw new TypeError(`Custom connector module was not found: ${name}`);
  }
  const actualFromRoot = relative(root, actual);
  if (!actualFromRoot || actualFromRoot.startsWith('..') || isAbsolute(actualFromRoot)) {
    throw new TypeError('Custom connector module must stay inside the custom connector directory');
  }
  return actual;
}

function customContext(context) {
  const environmentNames = stringArray(context.config?.environmentNames);
  const exposedEnvironment = Object.create(null);
  for (const name of environmentNames) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      throw new TypeError(`Invalid custom connector environment name: ${name}`);
    }
    if (typeof context.env?.[name] !== 'string') {
      throw new TypeError(`Custom connector environment variable is unavailable: ${name}`);
    }
    exposedEnvironment[name] = context.env[name];
  }
  const config = { ...(context.config ?? {}) };
  delete config.module;
  delete config.environmentNames;
  return deepFreeze(structuredClone({
    config,
    source: context.source ?? {},
    cursor: context.cursor ?? null,
    query: context.query ?? null,
    limit: context.limit ?? null,
    bindingId: context.bindingId ?? null,
    mode: context.mode ?? null,
    env: exposedEnvironment
  }));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const item of Object.values(value)) deepFreeze(item);
  return value;
}

function stringArray(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError('Custom connector environmentNames must be an array of strings');
  }
  return [...new Set(value)];
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required`);
  return value.trim();
}
