import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validatePluginManifest } from '../src/plugin-runtime.js';

const manifestPath = fileURLToPath(new URL('../plugin.json', import.meta.url));
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const validated = validatePluginManifest(manifest);
for (const capability of [
  'selection.read',
  'clipboard.write',
  'host.permissions',
  'model.provider'
]) {
  if (!validated.capabilities.includes(capability)) {
    throw new Error(`Plugin manifest is missing required capability: ${capability}`);
  }
}
const entryPath = fileURLToPath(new URL(validated.entry, new URL('../', import.meta.url)));
const entryStat = await stat(entryPath);
if (!entryStat.isFile()) throw new Error(`Plugin entry is not a file: ${validated.entry}`);
process.stdout.write(
  `Validated ${validated.id}@${validated.version}: ${validated.commands.length} commands, ${validated.capabilities.length} capabilities\n`
);
