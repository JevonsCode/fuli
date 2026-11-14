import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { dataFormatMarks, dataNewerThanThisPackage, dataUpgradedSince } from '../src/data-format/data-newer-than-package.js';

// Synthetic data directories only: what a previous version reads, without
// starting anything, before an app update swaps back to it.

function dataDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-newer-data-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('a data directory this version can run on names no reason', t => {
  assert.equal(dataNewerThanThisPackage(dataDirectory(t)), null);
});

test('a store a newer version upgraded keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 999 }));
  assert.match(dataNewerThanThisPackage(dataDir), /runtime-settings\.json already use a newer data format/);
});

test('a native Provider newer than this package keeps this version off the data', t => {
  const dataDir = dataDirectory(t);
  mkdirSync(join(dataDir, 'native-runtime'));
  writeFileSync(join(dataDir, 'native-runtime', 'manifest.json'), JSON.stringify({ providerVersion: '999.0.0+native.2' }));
  assert.match(dataNewerThanThisPackage(dataDir), /^provider_downgrade_refused installed=999\.0\.0\+native\.2 required=/);
});

test('a store the newer version moved past what the stopped one left is named; one it created is not', t => {
  const dataDir = dataDirectory(t);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 1 }));
  const marks = dataFormatMarks(dataDir);
  writeFileSync(join(dataDir, 'adaptive-runtime-settings.json'), JSON.stringify({ version: 1 }));
  assert.equal(dataUpgradedSince(marks, dataDir), null);
  writeFileSync(join(dataDir, 'runtime-settings.json'), JSON.stringify({ version: 2 }));
  assert.equal(dataUpgradedSince(marks, dataDir), 'runtime-settings.json already use a newer data format');
});
