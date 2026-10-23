import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { presencePort } from '../src/presence/port.js';
import { sha256Bytes } from '../src/security/digest.js';

// The Windows Hello adapter over a synthetic helper file and a stand-in
// process: the real fuli-win-helper.exe is never started, and no Hello dialog
// ever opens. windows overrides the adapter's options (pin, path, spawn, timeout).
export function windowsHello(t, windows = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fuli-win-helper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helperPath = join(directory, 'fuli-win-helper.exe');
  const bytes = 'synthetic helper bytes';
  writeFileSync(helperPath, bytes);
  return presencePort({ platform: 'win32', windows: { helperPath, pinnedDigest: sha256Bytes(Buffer.from(bytes)), ...windows } });
}

// A stand-in helper process: answers the request with `answer` (or raw
// `stdout`) and exits with `code`, or never exits. runs records each start.
export function fakeHelper({ answer = null, stdout = null, code = 0, exits = true } = {}) {
  const runs = [];
  const spawnHelper = (path, args) => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), killed: false,
      kill() { this.killed = true; } });
    let input = '';
    child.stdin.on('data', (chunk) => { input += chunk; });
    child.stdin.on('finish', () => {
      const request = JSON.parse(input);
      runs.push({ path, args, request, child });
      if (!exits) return;
      child.stdout.end(stdout
        ?? `${JSON.stringify({ protocol: 1, command: 'hello', challengeId: request.challengeId, ...answer })}\n`);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return { spawnHelper, runs };
}
