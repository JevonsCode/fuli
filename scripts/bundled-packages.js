import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// The packages the console bundle (dist/web) actually contains, as lockfile
// paths. They are devDependencies, since only the build installs them, yet
// they ship inside the package; scripts/audit-shipped.js counts them as shipped.
export const bundledPackagesFile = (root) => join(root, 'dist', 'web-bundled-packages.json');

// `node_modules/a`, `node_modules/@s/b/node_modules/c`: the package a module
// file belongs to, named the way npm-shrinkwrap.json names it.
const PACKAGE_PATH = /^node_modules\/(?:@[^/]+\/)?[^/]+(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*/;

export function bundledPackagesPlugin(root) {
  return {
    name: 'fuli-bundled-packages',
    apply: 'build',
    generateBundle(_options, bundle) {
      const paths = new Set();
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        for (const id of output.moduleIds) {
          const file = relative(root, id.replace(/^\0/, '').split('?')[0]).replaceAll('\\', '/');
          const match = file.match(PACKAGE_PATH);
          if (match) paths.add(match[0]);
        }
      }
      const file = bundledPackagesFile(root);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify([...paths].sort(), null, 2)}\n`);
    }
  };
}
