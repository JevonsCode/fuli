import { bundlePath, readBundleManifest } from './bundle-manifest.js';

// The runtime the macOS app ships in FULI.app/Contents/Resources/fuli
// (scripts/build-macos-app.js): a jlink'd Java 21, the pinned Neo4j archive
// and a relocatable Python with the Provider and its dependencies installed.
// Neo4j is unpacked into the data directory the way an npm installation
// installs it, so its version policy and asset lifecycle stay the same.
const PATH_KEYS = ['javaHome', 'neo4jArchive', 'providerPython', 'providerSource'];

export function readMacosNativeBundle(packageRoot) {
  const found = readBundleManifest(packageRoot);
  if (!found) return null;
  const { manifest, root } = found;
  if (manifest.version !== 1 || manifest.platform !== 'darwin' || !['arm64', 'x64'].includes(manifest.arch)
      || manifest.providerPackaging !== 'embedded') {
    throw new Error('The macOS app bundle manifest is not supported.');
  }
  return { ...Object.fromEntries(PATH_KEYS.map(key => [key, bundlePath(root, manifest[key], key)])),
    arch: manifest.arch, bundleRoot: root };
}
