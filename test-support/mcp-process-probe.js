#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [statusPath, ...serverArgs] = process.argv.slice(2);
const child = spawn(process.execPath, serverArgs, {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
let stderr = '';

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
  process.stderr.write(chunk);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('close', (code, signal) => {
  writeFileSync(statusPath, JSON.stringify({
    code,
    signal,
    stderr,
    childPid: child.pid
  }));
  process.exitCode = code ?? 1;
});
