import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { managedGraphInstances } from '../backup/runtime-adapters.js';

// Offline metadata only; never invoke database migrate/load or copy a store.
export async function readNeo4jStoreFormats(paths, descriptor, {
  instances = managedGraphInstances(paths), exists = existsSync, run = runCommand
} = {}) {
  const formats = {};
  for (const instance of instances) {
    const directory = instance === 'personal' ? paths.nativePersonalDir : paths.nativeWorkspaceDir;
    const from = join(directory, 'data', 'databases');
    if (!exists(from)) continue;
    const { stdout } = await run(join(descriptor.neo4jHome, 'bin', 'neo4j-admin'), [
      'database', 'info', '--format=json', `--from-path=${from}`, '*'
    ], { env: { ...process.env, JAVA_HOME: descriptor.javaHome, NEO4J_HOME: descriptor.neo4jHome,
      NEO4J_CONF: join(directory, 'conf') } });
    let rows;
    try { const body = JSON.parse(stdout); rows = Array.isArray(body) ? body : [body]; }
    catch { rows = stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    if (!rows.length) throw new Error('No offline Neo4j store metadata was returned.');
    for (const row of rows) {
      if (String(row.inUse) !== 'false' || String(row.recoveryRequired) !== 'false' || !row.databaseName || !row.storeFormat) {
        throw new Error('Neo4j store is in use, requires recovery, or has unknown format. Assets were not switched.');
      }
      formats[`${instance}:${row.databaseName}`] = row.storeFormat;
    }
  }
  return Object.fromEntries(Object.entries(formats).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function runCommand(command, args, options) {
  return new Promise((resolve, reject) => execFile(command, args, { ...options,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 4 * 1024 * 1024
  }, (error, stdout) => error ? reject(new Error('Could not inspect the offline Neo4j store format. No data was replaced.', { cause: error })) : resolve({ stdout })));
}
