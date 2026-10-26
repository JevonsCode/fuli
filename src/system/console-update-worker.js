import { resolveSetupPaths } from '../setup/paths.js';
import { runConsoleUpdate } from './console-update.js';
import { awaitConsoleAnswer } from './detached-job.js';

const [dataDir, id] = process.argv.slice(2);
if (!dataDir || !id) throw new TypeError('An update operation is required.');
await awaitConsoleAnswer();
await runConsoleUpdate(resolveSetupPaths({ dataDir }), id);
