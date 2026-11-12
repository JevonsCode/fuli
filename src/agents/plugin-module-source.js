import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The import lines of a generated client plugin file (OpenCode's plugin file,
// DeepSeek Harness's bundle): the file only binds this installation's paths to
// FULI's packaged plugin module, so the plugin's behaviour updates with the
// FULI package and the file changes only when its paths do.
//
// An absolute `plugin` is imported directly. A package-relative one is an
// installed Windows copy's: `launcher` (nodePath) is the launcher beside its
// installation.json (src/setup/paths.js, rec#11 D-80), and the module is
// imported from the version installation.json names when the client loads the
// file, so an update or rollback leaves the file as it is.
export function pluginModuleImport(plugin, launcher, exportName) {
  if (isAbsolute(plugin)) return `import { ${exportName} } from ${JSON.stringify(pathToFileURL(plugin).href)};\n`;
  const record = join(dirname(launcher), 'installation.json');
  return [
    "import { readFileSync } from 'node:fs';",
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    `const { packageRoot } = JSON.parse(readFileSync(${JSON.stringify(record)}, 'utf8'));`,
    `const { ${exportName} } = await import(pathToFileURL(join(packageRoot, ${JSON.stringify(plugin)})).href);`,
    ''
  ].join('\n');
}
