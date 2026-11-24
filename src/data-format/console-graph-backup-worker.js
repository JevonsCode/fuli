import { resolveSetupPaths } from '../setup/paths.js';
import { awaitConsoleAnswer } from '../system/detached-job.js';
import { runConsoleGraphBackup } from './console-graph-backup.js';

const [dataDir, id] = process.argv.slice(2);
if (!dataDir || !id) throw new TypeError('A graph backup operation is required.');
await awaitConsoleAnswer();
await runConsoleGraphBackup(resolveSetupPaths({ dataDir }), id);
