import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { maintenanceHoldsData } from '../data-format/maintenance-lock.js';
import { readJsonFile } from '../storage/json-file.js';
import { acquireConsoleStartLock, readConsoleAutostart } from './console-autostart-record.js';
import { isOwnProcessRunning } from './processes.js';

// What an AI is told when FULI does not answer it: which case this is, what
// it may do itself, what not, and the one sentence for the person. One text
// for every client (a hook's "FULI unavailable" answer and MCP's
// fuli_not_running), read from the data directory only when FULI did not
// answer, so a working FULI pays nothing for it.

// Each state's whole text, both languages; test/console-autostart.test.js pins it.
export const UNAVAILABLE_GUIDANCE_LIMIT = 600;

const NEVER = 'Never run fuli graph import/export/migrate/abandon-import or fuli graph runtime recover/unlock, '
  + 'delete files or end Neo4j; the person decides those when fuli status asks.';
const NEVER_ZH = '不要运行 fuli graph import/export/migrate/abandon-import、fuli graph runtime recover/unlock，'
  + '不删文件，不结束 Neo4j；这些在 fuli status 提示时由人决定。';

const GUIDANCE = Object.freeze({
  busy: ['FULI is running but answers slowly: this computer is busy. Do not restart it; carry on with this turn; '
    + 'FULI reconnects by itself. If you mention it, say: "Your computer is busy, so FULI is slow; it reconnects by itself."',
  '电脑很忙，FULI 应答慢。不要重启；本轮照常干活，恢复后自动接上。要提就说：「电脑现在很忙，FULI 应答慢，恢复后会自动接上。」'],
  starting: ['FULI is starting or restarting and will be back shortly. Wait for it; do not start it again.',
    'FULI 正在启动或重启，稍后恢复。等它，不要再启动一次。'],
  gave_up: ['FULI kept stopping; auto-start gave up. Run `fuli start` at most once; if it stops again, '
    + 'run `fuli status` (and `fuli diagnostics` if needed), tell the person what you saw, and do not start it again.',
  'FULI 反复停止，已放弃自动启动。最多运行一次 `fuli start`；再停就运行 `fuli status`（必要时 `fuli diagnostics`），把看到的告诉用户，不要再启动。'],
  maintenance: ['FULI waits for the person: a whole-store step such as a restore holds its data. Do not run `fuli start`. '
    + 'If you mention it, say: "FULI is waiting for you to handle something; do not start it yet."',
  'FULI 在等用户处理：整库恢复等维护操作占着数据。不要运行 `fuli start`。要提就说：「FULI 在等你处理一件事，先不要启动。」'],
  not_running: ['FULI is not running. Run `fuli start`, then `fuli status` to confirm.',
    'FULI 没在运行。运行 `fuli start`，再用 `fuli status` 确认。'],
  stopped_by_person: ['The person stopped FULI. If this task needs it, run `fuli start`, confirm with `fuli status`, '
    + 'and tell them: "You had stopped FULI; this task needs it, so I started it again."',
  '用户停了 FULI。任务需要时运行 `fuli start`，用 `fuli status` 确认，并告诉用户：「你之前停了 FULI，这个任务需要它，我已经重新启动。」'],
  waits_for_person: ['FULI is not started automatically while a data format update waits for the person. '
    + 'Tell the person once to start FULI and confirm it in the console under Settings, Data format.',
  '数据格式更新在等用户确认，FULI 不会自动启动。请告诉用户一次：启动 FULI，在控制台「设置 › 数据格式」确认。']
});

// busy | starting | gave_up | maintenance | not_running | stopped_by_person
// | waits_for_person, or null when the record cannot be read. A start under
// way holds the start lock (a restart holds it from its stop on,
// lifecycle.js); a console process that is alive without answering is busy,
// however long: client sessions replace one that stays silent
// (console-autostart.js). refused: the caller's connection was refused, so
// nothing listens; a live process is then no busy console, whatever owns its
// PID. A whole-store restore holding the data waits for the person.
export function fuliUnavailableState(dataDir, { refused = false, isAlive = isOwnProcessRunning,
  startUnderWay = startLockHeld, maintenanceUnderWay = maintenanceHoldsData } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || !existsSync(dataDir)) return null;
  let record;
  try { record = readConsoleAutostart(dataDir); } catch { return null; }
  if (record.unreadable) return null;
  if (record.held?.reason === 'data_format') return 'waits_for_person';
  if (maintenanceUnderWay(dataDir)) return 'maintenance';
  if (startUnderWay(dataDir)) return 'starting';
  if (!refused && consoleAlive(dataDir, isAlive)) return 'busy';
  if (record.stoppedAt) return 'stopped_by_person';
  return record.held?.reason === 'gave_up' ? 'gave_up' : 'not_running';
}

// The guidance for that state in both languages, or '' when none applies.
export function fuliUnavailableGuidance(dataDir, dependencies = {}) {
  const state = fuliUnavailableState(dataDir, dependencies);
  const [english, chinese] = GUIDANCE[state] ?? [];
  return english ? `${english} ${NEVER} / ${chinese}${NEVER_ZH}` : '';
}

function consoleAlive(dataDir, isAlive) {
  let state;
  try { state = readJsonFile(join(dataDir, 'graph-runtime-state.json'), null); } catch { return false; }
  return Number.isInteger(state?.pid) && isAlive(state.pid);
}

// Taken and given back at once: busy only while a start holds it.
function startLockHeld(dataDir) {
  try {
    acquireConsoleStartLock(dataDir)();
    return false;
  } catch (error) {
    return error?.code === 'file_lock_busy';
  }
}
