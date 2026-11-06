#!/usr/bin/env node
// Recomputes each plugin's digest in registry/occupation-plugins.json after a
// curator edits it (docs/occupation-plugins.md), then checks the whole file.
// Raise the plugin's version and the manifestVersion in the same edit.
import { readFileSync, writeFileSync } from 'node:fs';
import { occupationPluginDigest, parseOccupationPluginManifest } from '../src/occupation-plugins/manifest.js';

const file = new URL('../registry/occupation-plugins.json', import.meta.url);
const manifest = JSON.parse(readFileSync(file, 'utf8'));
for (const plugin of manifest.plugins) plugin.digest = occupationPluginDigest(plugin, manifest.sources);
parseOccupationPluginManifest(manifest);
writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`${manifest.plugins.length} plugin digests written; manifestVersion ${manifest.manifestVersion}.`);
