import { existsSync as fileExistsSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { createApplication } from './app/create-application.js';
import { SpaceKind } from './models.js';
import { resolveSetupPaths } from './setup/paths.js';
import { SqliteStore } from './storage/sqlite-store.js';

const LEGACY_LOCAL_DB_PATH = '.fuli/context.db';
const DEFAULT_PERSONAL_SPACE = '我';
const RETRY_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const RETRY_DELAY_MS = 5;
const STORE_OPEN_TIMEOUT_MS = 5000;

export class RuntimeConfigurationError extends TypeError {}

export function resolveRuntimeOptions(args = [], env = process.env, {
  cwd = process.cwd(),
  existsSync = fileExistsSync,
  setupPaths = {}
} = {}) {
  const cliDbPath = runtimeValue(args, '--db');
  const envDbPath = environmentValue(env, 'FULI_DB_PATH');
  const systemDbPath = resolveSetupPaths({ env, ...setupPaths }).dbPath;
  let defaultDbPath = systemDbPath;
  if (cliDbPath === null && envDbPath === null) {
    defaultDbPath = resolveDefaultDbPath({ cwd, existsSync, systemDbPath });
    guardImplicitDefaultUpgrade({ cwd, existsSync, systemDbPath });
  }
  return {
    dbPath: cliDbPath ?? envDbPath ?? defaultDbPath,
    personalSpaceName: runtimeValue(args, '--personal-space') ??
      environmentValue(env, 'FULI_PERSONAL_SPACE') ?? DEFAULT_PERSONAL_SPACE
  };
}

export function resolveStore({ dbPath }) {
  if (extname(dbPath).toLowerCase() === '.json') {
    const destination = dbPath.slice(0, -extname(dbPath).length) + '.db';
    throw new RuntimeConfigurationError(migrationMessage(dbPath, destination));
  }
  return openSqliteStore(dbPath);
}

export function quoteShellArgument(value, platform = process.platform) {
  const argument = String(value);
  if (platform === 'win32') {
    if (argument.includes('"')) {
      throw new TypeError('Windows paths cannot contain a double quote');
    }
    return `"${argument}"`;
  }
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

function resolveDefaultDbPath({ cwd, existsSync, systemDbPath }) {
  if (existsSync(systemDbPath)) return systemDbPath;
  if (existsSync(resolve(cwd, LEGACY_LOCAL_DB_PATH))) return LEGACY_LOCAL_DB_PATH;
  return systemDbPath;
}

function guardImplicitDefaultUpgrade({ cwd, existsSync, systemDbPath }) {
  const legacyPath = resolve(cwd, '.fuli/context.json');
  const localDatabasePath = resolve(cwd, LEGACY_LOCAL_DB_PATH);
  if (existsSync(legacyPath) && !existsSync(localDatabasePath)) {
    throw new RuntimeConfigurationError(migrationMessage(legacyPath, systemDbPath));
  }
}

function migrationMessage(source, destination) {
  return 'JSON is a legacy import format. Run once: node src/cli.js migrate ' +
    `--from ${quoteShellArgument(source)} --to ${quoteShellArgument(destination)}`;
}

export function openLocalApplication({ dbPath, personalSpaceName = DEFAULT_PERSONAL_SPACE }) {
  const store = resolveStore({ dbPath });
  const app = createApplication({ store, activePersonalSpaceName: personalSpaceName });
  try {
    initializeLocalSpaces(app, store, personalSpaceName);
    return app;
  } catch (error) {
    app.close();
    throw error;
  }
}

export function initializeLocalSpaces(app, store, personalSpaceName) {
  return store.transaction(() => {
    if (store.listSpaces().length === 0) {
      if (personalSpaceName === DEFAULT_PERSONAL_SPACE) {
        app.bootstrap();
      } else {
        const personal = app.createSpace(personalSpaceName, SpaceKind.PERSONAL);
        const project = app.createSpace('工作', SpaceKind.PUBLIC);
        app.subscribe(personal.id, project.id);
      }
    }
    return app.requireActivePersonalSpace();
  }, { mode: 'immediate' });
}

function runtimeValue(args, flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue;
    const value = args[index + 1];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new TypeError(`Missing value for ${flag}`);
    }
    values.push(value);
  }
  if (values.length > 1) throw new TypeError(`Duplicate ${flag}`);
  return values[0] ?? null;
}

function environmentValue(env, name) {
  const value = env?.[name];
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must not be empty`);
  }
  return value;
}

function openSqliteStore(dbPath) {
  const deadline = Date.now() + STORE_OPEN_TIMEOUT_MS;
  while (true) {
    try {
      return new SqliteStore(dbPath);
    } catch (error) {
      if (!isDatabaseBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(RETRY_BUFFER, 0, 0, RETRY_DELAY_MS);
    }
  }
}

function isDatabaseBusy(error) {
  return error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED';
}
