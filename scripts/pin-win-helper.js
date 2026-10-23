#!/usr/bin/env node
// Pins the SHA-256 of a CI-built fuli-win-helper.exe into
// src/presence/windows-helper-pin.js (rec#7 D-28.10). --expect is the digest
// the Windows build job reported; a file that differs from it stops the job.
//   node scripts/pin-win-helper.js native/win32/fuli-win-helper.exe --expect <sha256>
import { readFileSync, writeFileSync } from 'node:fs';

import { sha256Bytes } from '../src/security/digest.js';

const PIN = new URL('../src/presence/windows-helper-pin.js', import.meta.url);
const PIN_LINE = /^export const WIN_HELPER_SHA256 = (?:null|'[0-9a-f]{64}');$/m;
const DIGEST = /^[0-9a-f]{64}$/;

const [helper, flag, expected] = process.argv.slice(2);
if (!helper || flag !== '--expect' || !DIGEST.test(expected ?? '')) {
  console.error('Usage: node scripts/pin-win-helper.js HELPER_EXE --expect SHA256');
  process.exit(2);
}
const digest = sha256Bytes(readFileSync(helper));
if (digest !== expected) {
  console.error(`fuli-win-helper.exe is ${digest}, not the ${expected} the build reported; nothing pinned.`);
  process.exit(1);
}
const source = readFileSync(PIN, 'utf8');
if (!PIN_LINE.test(source)) {
  console.error('src/presence/windows-helper-pin.js has no pin line to replace.');
  process.exit(1);
}
writeFileSync(PIN, source.replace(PIN_LINE, `export const WIN_HELPER_SHA256 = '${digest}';`));
console.log(`Pinned fuli-win-helper.exe ${digest}`);
