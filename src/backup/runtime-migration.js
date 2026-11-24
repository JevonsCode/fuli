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
    // An import that left the native graph possibly half written keeps it
    // guarded (graph-backup.js): on macOS by the native runtime's lifecycle
    // lock, which this process holds, and stopping the native runtime would
    // need that lock. The import already stopped the native services and did
    // not start them again, so they are not stopped here; setting up
    // container mode does not touch the native runtime or its lock.
    const incomplete = error?.code === 'graph_import_incomplete';
    const lockKept = incomplete && error.lockKept === true;
    try {
      // Otherwise always stop: a native setup can fail after starting its own
      // graph processes on the same ports while the console never came up.
      if (!lockKept) await ports.stopRuntime();
      await ports.setupRuntime('container');
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError],
        `The move failed (${error.message}) and switching back to container mode also failed (${rollbackError.message}). ` +
        `The container graph was not changed; its export is at ${outputDir}.`);
    }
    if (incomplete) throw backOnContainer(error, outputDir, lockKept);
    throw new Error(`${error.message} Fuli is back on the unchanged container graph; its export is at ${outputDir}.`, { cause: error });
  }
}

// Back on the container graph after an import that left the native one
// guarded: the container side is whole and in use; the native side must be
// recovered (macOS) or imported whole (elsewhere) before another move.
function backOnContainer(error, outputDir, lockKept) {
  const [next, nextEn] = lockKept
    ? ['原生运行时留着一把维护锁：再次迁移之前，先运行 fuli graph runtime recover，它会把原生图谱退回到这次迁移之前（之前是空的就清空），容器数据不受影响。',
      'The native runtime keeps a maintenance lock: before moving again, run `fuli graph runtime recover`, which takes the native graph back to before this move (empty, if it was empty), leaving the container data alone.']
    : ['原生图谱上的这次导入没有完成，FULI 不会在原生模式下启动它：再次迁移之前，先照上面的命令把原生图谱导回或导完整，容器数据不受影响。',
      'The import into the native graph did not finish, and FULI does not start native mode on it: before moving again, bring the native graph back or import it whole with the command above, leaving the container data alone.'];
  return new Error(`${error.message}\n已回到容器图谱，可以正常使用，容器里的数据没有变；导出在 ${outputDir}。${next}`
    + `\nFuli is back on the container graph and can be used as usual; the container data did not change, and its export is at ${outputDir}. ${nextEn}`, { cause: error });
}

function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}
