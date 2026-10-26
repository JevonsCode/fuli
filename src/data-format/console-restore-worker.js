import { resolveSetupPaths } from '../setup/paths.js';
import { awaitConsoleAnswer } from '../system/detached-job.js';
import { runConsoleRestore } from './console-restore.js';

const [dataDir, id] = process.argv.slice(2);
if (!dataDir || !id) throw new TypeError('A restore operation is required.');
await awaitConsoleAnswer();
await runConsoleRestore(resolveSetupPaths({ dataDir }), id);
