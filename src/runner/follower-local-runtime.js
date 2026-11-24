import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { isProcessAlive } from '../local-runtime/processes.js';
import { readJsonFile, writeJsonFileAtomic } from '../storage/json-file.js';

// A follower's own runtime (docs/runner-roles-design.md §10, step 3a): every
// FULI is a complete FULI, so a computer that follows a host gets its own
// graph runtime (Neo4j and the Provider) too, prepared in the background the
// first time it starts with this version. Nothing is routed to it until the
// person makes a scope this computer's (step 3c), so a runtime that is not
// ready, or failed, changes nothing for the calls that go to the host; it is
// said as it is wherever this computer's state is shown.
//
// While no scope is this computer's, Neo4j does not stay running: the
// preparation installs it, checks that it starts, and stops it again
// (follower-runtime-prepare.js).
//
// RECORD_FILE holds the outcome of the last preparation. It is process state,
// not FULI data: losing it only means the next start prepares again.
//   { state: 'preparing', pid, startedAt, createdHere }
//   { state: 'ready', at, version, createdHere, running, projects: [ids in the local graph] }
//   { state: 'failed', at, version, createdHere, code, message, freeBytes?, needBytes? }
// createdHere: the preparation made this computer's graph itself (there was no
// graph-runtime.json before it), so the graph holds nothing of the person's.
export const RECORD_FILE = join('runner', 'local-runtime.json');
const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const LOG_FILE = join('logs', 'runner-local-runtime.log');

// This computer's runtime as every surface shows it:
//   { state: 'not_prepared' }
//   { state: 'preparing', since }
//   { state: 'ready', at, running, projects, createdHere }
//   { state: 'failed', at, code, message, freeBytes?, needBytes?, createdHere }
export function readLocalRuntime(dataDir, { alive = isProcessAlive } = {}) {
  const record = readRecord(dataDir);
  if (!record) return { state: 'not_prepared' };
  if (record.state === 'preparing') {
    return alive(record.pid) ? { state: 'preparing', since: record.startedAt ?? null }
      : { state: 'failed', at: record.startedAt ?? null, code: 'interrupted', createdHere: record.createdHere === true,
        message: 'The preparation stopped before it finished (the computer slept or FULI was closed).' };
  }
  if (record.state === 'ready') {
    return { state: 'ready', at: record.at ?? null, running: record.running === true,
      projects: Array.isArray(record.projects) ? record.projects : [], createdHere: record.createdHere === true };
  }
  if (record.state === 'failed') {
    return { state: 'failed', at: record.at ?? null, code: String(record.code ?? 'prepare_failed'),
      message: String(record.message ?? ''), createdHere: record.createdHere === true,
      ...(Number.isFinite(record.freeBytes) ? { freeBytes: record.freeBytes, needBytes: record.needBytes } : {}) };
  }
  return { state: 'not_prepared' };
}

// The raw record, or null when there is none or it cannot be read.
export function readRecord(dataDir) {
  try {
    const record = readJsonFile(join(dataDir, RECORD_FILE), null);
    return record && typeof record === 'object' ? record : null;
  } catch { return null; }
}

export function writeRecord(dataDir, record) {
  writeJsonFileAtomic(join(dataDir, RECORD_FILE), record);
}

// Whether this computer's graph holds nothing of the person's: the follower
// made it itself and found no project in it, so joining a host (which follows
// it for everything) hides nothing.
export function graphHoldsNothingOfThePerson(state) {
  return state.state !== 'not_prepared' && state.createdHere === true && !(state.projects?.length > 0);
}

// Starts the preparation as a detached process when it is not done and not
// under way: at every start of this computer's console, at `fuli setup`, and
// when the person presses 「重新准备」. A failed one is tried again then, never
// in a loop. Answers whether a preparation was started.
export function prepareInBackground({ dataDir, execPath = process.execPath, spawnProcess = spawn,
  alive = isProcessAlive } = {}) {
  const state = readLocalRuntime(dataDir, { alive });
  if (state.state === 'ready' || state.state === 'preparing') return false;
  const log = openChildProcessLog(join(dataDir, LOG_FILE));
  const child = spawnProcess(execPath, [CLI_PATH, 'runner', 'prepare-local', '--data-dir', dataDir],
    { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  child.unref?.();
  return true;
}

// A start of this data directory as its own FULI (after `fuli runner leave`):
// the graph is the person's own from then on, and no longer what the record says.
export function forgetFollowerRuntime(dataDir) {
  rmSync(join(dataDir, RECORD_FILE), { force: true });
}

const GIB = 1024 ** 3;
const gigabytes = (bytes) => (bytes / GIB).toFixed(1);

// One line about it, in both languages, and what to do when it needs the person.
export function localRuntimeLine(state) {
  if (!state) return null;
  switch (state.state) {
    case 'preparing':
      return { zh: '本机运行时：正在后台准备（安装并检查本机数据库），转发到主机的调用不受影响。',
        en: 'This computer\'s own runtime: being prepared in the background; calls that go to the host are not affected.' };
    case 'ready':
      return state.running
        ? { zh: '本机运行时：已准备好，正在运行。', en: 'This computer\'s own runtime: prepared and running.' }
        : { zh: '本机运行时：已准备好，未运行（还没有本机项目）。',
          en: 'This computer\'s own runtime: prepared, not running (no project is this computer\'s yet).' };
    case 'failed':
      if (state.code === 'disk_low') {
        return { zh: `本机运行时：没有准备，磁盘只剩 ${gigabytes(state.freeBytes)} GB，需要 ${gigabytes(state.needBytes)} GB。转发到主机的调用不受影响。`,
          en: `This computer's own runtime: not prepared, ${gigabytes(state.freeBytes)} GB free of the ${gigabytes(state.needBytes)} GB it needs. `
            + 'Calls that go to the host are not affected.' };
      }
      return { zh: `本机运行时：准备没有成功（${state.code}）。转发到主机的调用不受影响。`,
        en: `This computer's own runtime: the preparation did not succeed (${state.code}). Calls that go to the host are not affected.` };
    default:
      return { zh: '本机运行时：还没准备，这台电脑的控制台启动后会在后台准备。',
        en: 'This computer\'s own runtime: not prepared yet; it is prepared in the background once this computer\'s console starts.' };
  }
}

// The short part of the line every surface shows first (follower-status.js followerLine).
export function localRuntimeShort(state) {
  const short = {
    not_prepared: { zh: '本机运行时未准备', en: 'own runtime not prepared' },
    preparing: { zh: '本机运行时准备中', en: 'own runtime being prepared' },
    ready: state?.running ? { zh: '本机运行时运行中', en: 'own runtime running' }
      : { zh: '本机运行时已备好（未运行）', en: 'own runtime prepared (not running)' },
    failed: { zh: '本机运行时准备失败', en: 'own runtime not prepared' }
  };
  return state ? short[state.state] ?? short.not_prepared : null;
}

// What the person can do about a runtime that is not ready, for the CLI. The
// console page offers the same as one button (follower-page.js).
export function localRuntimeStep(state) {
  if (state.state === 'preparing') return 'It finishes by itself; nothing to do.';
  if (state.state === 'ready') return null;
  const again = 'Press 「重新准备 / Prepare again」 on this computer\'s console page, or start FULI again (`fuli start`).';
  if (state.state === 'failed' && state.code === 'disk_low') return `Free ${gigabytes(state.needBytes - state.freeBytes)} GB or more on this disk, then: ${again}`;
  if (state.state === 'failed') return `What happened is in ${LOG_FILE} in the data directory. ${again}`;
  return 'Start FULI on this computer (`fuli start`, or open FULI.app); the preparation runs in the background.';
}
