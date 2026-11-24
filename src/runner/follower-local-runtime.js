import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openChildProcessLog } from '../local-runtime/child-process-log.js';
import { FULI_VERSION } from '../package-metadata.js';
import { acquireFileLock } from '../storage/file-lock.js';
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
//   { state: 'existing', at, version, createdHere: false }
// createdHere: the preparation made this computer's graph itself (there was no
// graph-runtime.json before it), so the graph holds nothing of the person's.
// 'existing': a graph was here before any preparation (a FULI of its own); the
// preparation does not start, upgrade or change it.
export const RECORD_FILE = join('runner', 'local-runtime.json');
const CLI_PATH = fileURLToPath(new URL('../cli.js', import.meta.url));
const LOG_FILE = join('logs', 'runner-local-runtime.log');

// One preparation at a time, without trusting a PID: the preparing process
// holds LOCK_FILE (an OS lock, let go when that process ends however it ends)
// for its whole run. Between a start and that process taking the lock, the
// starter's CLAIM_FILE (created only if absent) keeps a second start out; the
// preparing process removes it once it holds the lock. A claim no process took
// over within CLAIM_TTL_MS (the process never started) is stale.
const LOCK_FILE = join('runner', 'local-runtime.lock');
const CLAIM_FILE = join('runner', 'local-runtime.claim');
export const CLAIM_TTL_MS = 2 * 60 * 1000;

// This computer's runtime as every surface shows it:
//   { state: 'not_prepared' }
//   { state: 'preparing', since }
//   { state: 'ready', at, running, projects, createdHere }
//   { state: 'failed', at, code, message, version, freeBytes?, needBytes?, createdHere }
//   { state: 'existing', at, createdHere: false }
export function readLocalRuntime(dataDir, { underWay = preparationUnderWay, now = Date.now } = {}) {
  const record = readRecord(dataDir);
  if (record?.state === 'preparing' && underWay(dataDir)) return { state: 'preparing', since: record.startedAt ?? null };
  // A start spawned a preparation that has not taken over yet.
  const claim = freshClaim(dataDir, now);
  if (claim) return { state: 'preparing', since: claim.at ?? null };
  if (!record) return { state: 'not_prepared' };
  if (record.state === 'preparing') {
    return { state: 'failed', at: record.startedAt ?? null, code: 'interrupted', createdHere: record.createdHere === true,
      message: 'The preparation stopped before it finished (the computer slept or FULI was closed).' };
  }
  if (record.state === 'ready') {
    return { state: 'ready', at: record.at ?? null, running: record.running === true,
      projects: Array.isArray(record.projects) ? record.projects : [], createdHere: record.createdHere === true };
  }
  if (record.state === 'failed') {
    return { state: 'failed', at: record.at ?? null, code: String(record.code ?? 'prepare_failed'),
      message: String(record.message ?? ''), version: record.version ?? null, createdHere: record.createdHere === true,
      ...(Number.isFinite(record.freeBytes) ? { freeBytes: record.freeBytes, needBytes: record.needBytes } : {}) };
  }
  if (record.state === 'existing') return { state: 'existing', at: record.at ?? null, createdHere: false };
  return { state: 'not_prepared' };
}

// Held by the preparing process for its whole run; null when another holds it.
export function holdPreparationLock(dataDir, { waitMs = 5000 } = {}) {
  try { return acquireFileLock(join(dataDir, LOCK_FILE), { waitMs }); } catch (error) {
    if (error?.code === 'file_lock_busy') return null;
    throw error;
  }
}

// Whether a preparing process holds the lock now.
function preparationUnderWay(dataDir) {
  const release = holdPreparationLock(dataDir, { waitMs: 0 });
  if (!release) return true;
  release();
  return false;
}

// The preparing process took the starter's claim over (it holds the lock now).
export function dropPreparationClaim(dataDir) {
  rmSync(join(dataDir, CLAIM_FILE), { force: true });
}

function freshClaim(dataDir, now) {
  try {
    const claim = readJsonFile(join(dataDir, CLAIM_FILE), null);
    const age = now() - Date.parse(claim?.at);
    // A claim dated ahead of this clock (the clock was set back) is stale too, never held for good.
    return Number.isFinite(age) && age >= 0 && age < CLAIM_TTL_MS ? claim : null;
  } catch { return null; }
}

// Created only when there is none (or only a stale one): the one start that gets it spawns the preparation.
function claimPreparation(dataDir, now) {
  const path = join(dataDir, CLAIM_FILE);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST' || freshClaim(dataDir, now)) return false;
      dropPreparationClaim(dataDir);
    }
  }
  return false;
}

// A failed preparation the next start tries again by itself: one cut short, one
// that found too little disk (freed since, perhaps), or one by another FULI
// version. Any other failure would fail the same way at every start, starting
// Neo4j each time: it waits for 「重新准备」.
export function retriesByItself(state) {
  return state.state === 'failed'
    && (state.code === 'interrupted' || state.code === 'disk_low' || state.version !== FULI_VERSION);
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
// under way: at every start of this computer's console and at `fuli setup`
// (only a failure that retriesByItself is tried again then, never in a loop),
// and when the person presses 「重新准备」 (again: any failure). Answers whether
// this call started one; when another start got there first, it did not.
export function prepareInBackground({ dataDir, again = false, execPath = process.execPath, spawnProcess = spawn,
  underWay = preparationUnderWay, now = Date.now } = {}) {
  const state = readLocalRuntime(dataDir, { underWay, now });
  if (state.state !== 'not_prepared' && state.state !== 'failed') return false;
  if (state.state === 'failed' && !again && !retriesByItself(state)) return false;
  if (!claimPreparation(dataDir, now)) return false;
  let log = null;
  try {
    log = openChildProcessLog(join(dataDir, LOG_FILE));
    const child = spawnProcess(execPath, [CLI_PATH, 'runner', 'prepare-local', '--data-dir', dataDir],
      { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    child.unref?.();
  } catch (error) {
    dropPreparationClaim(dataDir);
    throw error;
  } finally {
    // The child writes through its own copy; this process keeps no handle on the log
    // (on Windows an open handle keeps the file, and its folder, from being removed).
    if (log !== null) closeSync(log);
  }
  return true;
}

// A start of this data directory as its own FULI (after `fuli runner leave`):
// the graph is the person's own from then on, and no longer what the record says.
export function forgetFollowerRuntime(dataDir) {
  rmSync(join(dataDir, RECORD_FILE), { force: true });
  dropPreparationClaim(dataDir);
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
    case 'existing':
      return { zh: '本机运行时：本机已有图谱，这一步没有动它（没有启动、升级或修改）。转发到主机的调用不受影响。',
        en: 'This computer\'s own runtime: this computer already has a graph of its own; this step left it alone '
          + '(not started, upgraded or changed). Calls that go to the host are not affected.' };
    case 'failed':
      if (state.code === 'disk_low') {
        return { zh: `本机运行时：没有准备，磁盘只剩 ${gigabytes(state.freeBytes)} GB，需要 ${gigabytes(state.needBytes)} GB。转发到主机的调用不受影响。`,
          en: `This computer's own runtime: not prepared, ${gigabytes(state.freeBytes)} GB free of the ${gigabytes(state.needBytes)} GB it needs. `
            + 'Calls that go to the host are not affected.' };
      }
      return retriesByItself(state)
        ? { zh: `本机运行时：准备没有成功（${state.code}），下次启动会自动再试。转发到主机的调用不受影响。`,
          en: `This computer's own runtime: the preparation did not succeed (${state.code}); the next start tries again. `
            + 'Calls that go to the host are not affected.' }
        : { zh: `本机运行时：准备没有成功（${state.code}），不会自动再试，免得每次启动都白白起一遍数据库；`
            + '看过原因后按「重新准备」。转发到主机的调用不受影响。',
          en: `This computer's own runtime: the preparation did not succeed (${state.code}). It is not tried again by itself, `
            + 'so that no start runs the database for nothing; press 「重新准备 / Prepare again」 once the reason is seen to. '
            + 'Calls that go to the host are not affected.' };
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
    existing: { zh: '本机已有图谱（未改动）', en: 'own graph already here (left alone)' },
    failed: { zh: '本机运行时准备失败', en: 'own runtime preparation failed' }
  };
  return state ? short[state.state] ?? short.not_prepared : null;
}

// What the person can do about a runtime that is not ready, for the CLI. The
// console page offers the same as one button (follower-page.js).
export function localRuntimeStep(state) {
  if (state.state === 'preparing') return 'It finishes by itself; nothing to do.';
  if (state.state === 'ready' || state.state === 'existing') return null;
  const press = 'Press 「重新准备 / Prepare again」 on this computer\'s console page (or run `fuli runner prepare-local`).';
  if (state.state === 'failed' && state.code === 'disk_low') {
    return `Free ${gigabytes(state.needBytes - state.freeBytes)} GB or more on this disk; the next start of FULI tries again, or now: ${press}`;
  }
  if (state.state === 'failed') {
    return `What happened is in ${LOG_FILE} in the data directory. `
      + (retriesByItself(state) ? `The next start of FULI tries again, or now: ${press}` : `Then: ${press}`);
  }
  return 'Start FULI on this computer (`fuli start`, or open FULI.app); the preparation runs in the background.';
}

// Why `fuli runner join` and `fuli routes follow global` wait while a preparation is under way:
// the graph it is making is not yet known to hold nothing of the person's.
export const PREPARING_WAIT = {
  zh: '这台电脑正在后台准备本机运行时，准备完再试（`fuli status` 会说什么时候好）。什么都没改。',
  en: 'This computer\'s own runtime is being prepared in the background; try again once it is done '
    + '(`fuli status` says when). Nothing was changed.'
};
