import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OPENCODE_LIFECYCLE_MARKER } from './plugin.js';

// The file FULI setup writes at `<OpenCode config>/plugins/fuli/index.js`.
// OpenCode V2 loads a plugins/<name>/ directory through its index (or server)
// module and needs a default export with an id and a setup function. The file
// only binds this installation's paths to the packaged plugin.js, so the
// plugin's behaviour updates with the FULI package and the file changes only
// when its paths or the descriptor pack's hooks do.
const HEADER = `// FULI managed OpenCode plugin (${OPENCODE_LIFECYCLE_MARKER}): fuli setup rewrites this file and fuli uninstall removes it.`;

// `hooks` is the descriptor pack's lifecycleHooks; the hook's own deadline
// leaves the plugin's kill timer room inside the pack's timeout.
export function openCodePluginSource(context, hooks) {
  const directory = join(dirname(context.mcpServerPath), 'agents', 'opencode');
  const config = {
    nodePath: context.nodePath,
    hookPath: join(directory, 'lifecycle-hook.js'),
    runtimeConfigPath: context.runtimeConfigPath,
    events: hooks.events.map(({ event }) => event),
    timeoutMs: Math.max(1000, hooks.timeoutSec * 1000 - 2000)
  };
  const plugin = join(directory, 'plugin.js');
  return `${HEADER}\n${isAbsolute(plugin) ? packagedImport(plugin) : installedImport(context.nodePath, plugin)}\n`
    + `export default fuliOpenCodePlugin(${JSON.stringify(config, null, 2)});\n`;
}

function packagedImport(plugin) {
  return `import { fuliOpenCodePlugin } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`;
}

// Package-relative scripts are an installed Windows copy's: nodePath is the
// launcher beside its installation.json (src/setup/paths.js, rec#11 D-80). The
// hook runs through that launcher, and the plugin module is imported from the
// version installation.json names when OpenCode loads the file, so an update or
// rollback leaves this file as it is.
function installedImport(launcher, plugin) {
  const record = join(dirname(launcher), 'installation.json');
  return [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    `const { packageRoot } = JSON.parse(readFileSync(${JSON.stringify(record)}, 'utf8'));`,
    `const { fuliOpenCodePlugin } = await import(pathToFileURL(join(packageRoot, ${JSON.stringify(plugin)})).href);`,
    ''
  ].join('\n');
}

export function isFuliOpenCodePlugin(text) {
  return typeof text === 'string' && text.startsWith(HEADER);
}
