import { resolveSetupPaths } from '../setup/paths.js';
import { runSettingsApply } from './settings-apply.js';

const [dataDir, id] = process.argv.slice(2);
if (!dataDir || !id) throw new TypeError('A settings operation is required.');
await runSettingsApply(resolveSetupPaths({ dataDir }), id);
