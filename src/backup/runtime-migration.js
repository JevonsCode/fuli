import { join } from 'node:path';

import { censusDifferences } from './graph-census.js';

/**
 * Moves an existing container graph into the native runtime on the same data
 * directory. The container volume is only read: it is counted, dumped and
 * then left stopped, so a failure anywhere switches back to the unchanged
 * container graph. The move is accepted only when the native graph's census
 * equals the container graph's census taken with no writer running.
 *
 * Every side effect goes through `ports`, so the order can be tested exactly:
 *   runtimeMode(), consoleRunning(), stopRuntime(), startRuntime(), createAdapter(mode),
 *   exportGraph({ adapter, outputDir }), importGraph({ adapter, inputDir }),
 *   setupRuntime(mode), write(line)
 */
export async function migrateContainerGraphToNative({ backupRoot, now = () => new Date(), ports }) {
  const mode = ports.runtimeMode();
  if (mode === 'native') return { status: 'already_native' };
  if (mode !== 'container') throw new Error('Only a container graph can be moved to native mode.');
  // Missing native assets must fail before anything is stopped.
  await ports.checkNative();

  if (await ports.consoleRunning()) {
    ports.write('Stopping the running Fuli console and container services...');
    const stopped = await ports.stopRuntime();
    if (stopped?.status === 'partial') {
      throw new Error('Could not confirm that the running Fuli console stopped. Nothing was changed.');
    }
  }

  // Source side: read only. Providers are stopped, so nothing writes while
  // the container database is counted and dumped.
  const container = await ports.createAdapter('container');
  const sourceCensus = {};
  for (const instance of container.instances) {
    ports.write(`Counting the container ${instance} graph...`);
    sourceCensus[instance] = await container.census(instance);
  }
  const outputDir = join(backupRoot, `container-to-native-${stamp(now())}`);
  ports.write(`Exporting the container graph to ${outputDir}...`);
  await ports.exportGraph({ adapter: container, outputDir });

  let switched = false;
  try {
    ports.write('Setting up the native graph runtime (no Docker)...');
    switched = true;
    await ports.setupRuntime('native');
    if (await ports.consoleRunning()) {
      const stopped = await ports.stopRuntime();
      if (stopped?.status === 'partial') throw new Error('Could not stop the new native runtime before importing.');
    }
    const native = await ports.createAdapter('native');
    ports.write('Importing the exported graph into the native runtime...');
    await ports.importGraph({ adapter: native, inputDir: outputDir });
    const differences = [];
    const targetCensus = {};
    for (const instance of container.instances) {
      targetCensus[instance] = await native.census(instance);
      differences.push(...censusDifferences(sourceCensus[instance], targetCensus[instance])
        .map((difference) => `${instance} ${difference}`));
    }
    if (differences.length) {
      throw new Error(`The native graph does not match the container graph: ${differences.join('; ')}`);
    }
    ports.write('Starting Fuli on the native runtime...');
    await ports.startRuntime();
    return { status: 'migrated', backupDir: outputDir, census: targetCensus };
  } catch (error) {
    if (!switched) throw error;
    ports.write('The move did not complete; switching back to the unchanged container graph...');
    try {
      if (await ports.consoleRunning()) await ports.stopRuntime();
      await ports.setupRuntime('container');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `The move failed and switching back to container mode also failed. The container graph was not changed; its export is at ${outputDir}.`);
    }
    throw new Error(`${error.message} Fuli is back on the unchanged container graph; its export is at ${outputDir}.`, { cause: error });
  }
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}
