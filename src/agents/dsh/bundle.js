import { dirname, join } from 'node:path';

import { FULI_VERSION } from '../../package-metadata.js';
import { pluginModuleImport } from '../plugin-module-source.js';
import { DSH_LIFECYCLE_MARKER } from './plugin.js';

// The DeepSeek Harness bundle FULI setup writes beside its installer manifest
// (installer-manifest.js): a package a DSH profile adds by link
// (`dsh plugin --profile <name> add link:<directory>`). DSH loads a bundle
// through its package.json `dsh.bundle.patch`, whose rows here start FULI's
// lifecycle plugin (plugin.js) and FULI's MCP server, run as the `dsh`
// source. The files bind this installation's paths and name FULI's version;
// the profile links the directory, so a rewrite after a FULI update needs no
// reinstall.
const DSH_BUNDLE_PACKAGE = 'fuli-dsh';
const HEADER = `// FULI managed DeepSeek Harness plugin (${DSH_LIFECYCLE_MARKER}): fuli setup rewrites this file.`;
// The hook's own prompt deadline (plugin-lifecycle-hook.js caps it at 15 s).
const PROMPT_TIMEOUT_MS = 15_000;

// Answers { 'package.json', 'index.js', 'cordis.patch.yml' }: file name to text.
export function dshBundleFiles(context) {
  const directory = join(dirname(context.mcpServerPath), 'agents', 'dsh');
  const config = {
    nodePath: context.nodePath,
    hookPath: join(directory, 'lifecycle-hook.js'),
    runtimeConfigPath: context.runtimeConfigPath,
    timeoutMs: PROMPT_TIMEOUT_MS
  };
  const manifest = { name: DSH_BUNDLE_PACKAGE, version: FULI_VERSION, private: true, type: 'module', main: 'index.js',
    description: 'FULI memory, preferences and task records for DeepSeek Harness',
    dsh: { bundle: { patch: './cordis.patch.yml' } } };
  return {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'index.js': `${HEADER}\n${pluginModuleImport(join(directory, 'plugin.js'), context.nodePath, 'fuliDshPlugin')}\n`
      + `export const { name, inject, apply } = fuliDshPlugin(${JSON.stringify(config, null, 2)});\n`,
    'cordis.patch.yml': patchText(context)
  };
}

// JSON is YAML, so each row is written as one JSON flow mapping.
function patchText(context) {
  const rows = [
    { id: 'fuli', name: DSH_BUNDLE_PACKAGE },
    { id: 'fuli-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: 'fuli',
      command: context.nodePath, args: [context.mcpServerPath, '--runtime-config', context.runtimeConfigPath,
        '--source-application', 'dsh', '--tool-profile', 'chat'] } }
  ];
  return `# ${HEADER.slice(3)}\n- insert:\n${rows.map((row) => `    - ${JSON.stringify(row)}\n`).join('')}`;
}
