// The phases a FULI start really goes through, in the order ensureGraphRuntime
// (src/setup/graph-runtime.js) runs them. A start reports the phase it enters
// and nothing else: there is no progress to report, because none of these
// steps counts anything. The three longest of them used to print nothing at
// all, so a person watching `fuli start`, the macOS app or the Windows tray
// saw a turning mark for up to five minutes with no idea what it waited for.
//
// The ids are the contract. The desktop client keeps its own copy of these
// sentences (desktop/flutter/lib/src/l10n/strings.dart), the way it already
// does for the update steps that src/system/console-update.js reports.

export const STARTUP_STAGES = Object.freeze([
  // The desktop client's own steps around the start (desktop-controller.js).
  'checking',
  'first_setup',
  // ensureNativeRuntime / ensureContainerRuntime: install or find the database.
  'graph_runtime',
  // startNativeProviders / startProviders: the database and Provider processes.
  'graph_start',
  // waitForProviderHealth: up to 2 minutes per Provider.
  'provider_wait',
  // bootstrapGraph, the config reconciliation and the identity upgrade.
  'graph_setup',
  // spawnWebRuntime and waitForWeb: up to 1 minute.
  'console_start',
  // The desktop client again: `fuli open` after a start-and-open.
  'console_open'
]);

const STAGE_TEXT = Object.freeze({
  checking: { zh: '正在看 FULI 现在的状态', en: 'Checking what FULI is doing now' },
  first_setup: { zh: '第一次启动，正在安装 FULI', en: 'First start: installing FULI' },
  graph_runtime: { zh: '正在准备图数据库', en: 'Getting the graph database ready' },
  graph_start: { zh: '正在启动图数据库', en: 'Starting the graph database' },
  provider_wait: { zh: '正在等 Provider 就绪', en: 'Waiting for the Provider' },
  graph_setup: { zh: '正在核对知识图谱的设置', en: 'Checking the knowledge graph setup' },
  console_start: { zh: '正在打开控制台', en: 'Starting the console' },
  console_open: { zh: '正在打开控制台窗口', en: 'Opening the console window' }
});

// Whether this is one of the phases a start reports.
export function isStartupStage(stage) {
  return Object.hasOwn(STAGE_TEXT, stage);
}

// The line a terminal shows while the phase runs, in both languages, the way
// the rest of the CLI and the tray write them.
export function startupStageLine(stage) {
  const text = STAGE_TEXT[stage];
  if (!text) throw new TypeError(`Unknown startup stage: ${stage}`);
  return `${text.zh}… / ${text.en}…`;
}

// A client that follows a start reads its stdout line by line, so the phase
// goes out as one JSON line, the same shape whether it comes from the CLI
// itself or from a desktop controller relaying it (desktop-controller.js).
// A result line carries `ok`, so the two are never confused.
export function startupStageMarker(stage) {
  if (!isStartupStage(stage)) throw new TypeError(`Unknown startup stage: ${stage}`);
  return JSON.stringify({ stage });
}

// The stage a line carries, or null for any other line of output.
export function readStartupStageMarker(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Object.hasOwn(value, 'ok')) return null;
  return isStartupStage(value.stage) ? value.stage : null;
}

// Set by a desktop client on the start it runs (src/desktop/desktop-controller.js):
// it renders the phase itself, so its CLI writes the marker instead of prose.
export const STAGE_MARKER_ENV = 'FULI_STAGE_MARKERS';

// How a start reports its phase on stdout: the person's sentence in a
// terminal, the marker line when a client is reading along.
export function startupStageWriter(write, env = process.env) {
  const markers = env?.[STAGE_MARKER_ENV] === '1';
  return (stage) => write(markers ? startupStageMarker(stage) : startupStageLine(stage));
}
