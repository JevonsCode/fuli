// The phases a FULI start really goes through. A start reports the phase it
// enters where that phase begins, and nothing else: none of these steps counts
// anything, so there is no progress to report. A phase whose wait has a fixed
// limit reports that limit too (maxSeconds), taken from the constant the wait
// itself uses, so what a person reads is what the code will do.
//
// The ids are the contract. The desktop client keeps its own copy of these
// sentences (desktop/flutter/lib/src/l10n/strings.dart), the way it does for the
// update steps; test/startup-stage.test.js keeps the two lists the same.

const STAGE_TEXT = Object.freeze({
  // The desktop client's own steps around the start (desktop-controller.js).
  checking: { zh: '正在看 FULI 现在的状态', en: 'Checking what FULI is doing now' },
  first_setup: { zh: '第一次启动，正在安装 FULI', en: 'First start: installing FULI' },
  // The window's way out of an unfinished import, before the start (unfinished-import-plan.js).
  graph_import: { zh: '正在导入图谱，导完再启动', en: 'Importing the graph; FULI starts once it is done' },
  import_abandon: { zh: '正在放弃这次导入，挪开可能只写了一半的图谱', en: 'Giving the import up: moving the graph that may be half written aside' },
  // Another start of the same data holds the start lock (lifecycle.js).
  start_wait: { zh: '正在等另一次启动结束', en: 'Waiting for another start to finish' },
  // ensureNativeRuntime / ensureContainerRuntime: find the database program.
  graph_runtime: { zh: '正在准备图数据库', en: 'Getting the graph database ready' },
  // The database archive or the Provider is being installed (native runtime).
  graph_install: { zh: '正在安装图数据库程序', en: 'Installing the graph database programs' },
  // The database and Provider processes are being started.
  graph_start: { zh: '正在启动图数据库', en: 'Starting the graph database' },
  // The native Neo4j has started and is opening its ports.
  database_wait: { zh: '正在等图数据库打开端口', en: 'Waiting for the graph database to open its ports' },
  // The Provider has started and is not answering yet.
  provider_wait: { zh: '正在等 Provider 就绪', en: 'Waiting for the Provider' },
  // bootstrapGraph, the config reconciliation and the identity upgrade.
  graph_setup: { zh: '正在核对知识图谱的设置', en: 'Checking the knowledge graph setup' },
  // The console process is started and answered for.
  console_start: { zh: '正在打开控制台', en: 'Starting the console' },
  // The desktop client again: `fuli open` after a start-and-open.
  console_open: { zh: '正在打开控制台窗口', en: 'Opening the console window' }
});

// The line a terminal shows while the phase runs, in both languages, the way
// the rest of the CLI and the tray write them.
function startupStageLine(stage, { maxSeconds = null } = {}) {
  const text = STAGE_TEXT[stage];
  if (!text) throw new TypeError(`Unknown startup stage: ${stage}`);
  if (!Number.isInteger(maxSeconds)) return `${text.zh}… / ${text.en}…`;
  return `${text.zh}（最多 ${maxSeconds} 秒）… / ${text.en} (up to ${maxSeconds} s)…`;
}

// A client that follows a start reads its stdout line by line, so a phase goes
// out as one JSON line, the same whether from the CLI or a desktop controller
// relaying it. A result line carries `ok`, so it is never mistaken for one. (A
// failure's reason goes on stderr instead: startup-failure-line.js.)
export function startupStageMarker(stage, { maxSeconds = null } = {}) {
  if (!Object.hasOwn(STAGE_TEXT, stage)) throw new TypeError(`Unknown startup stage: ${stage}`);
  return JSON.stringify(Number.isInteger(maxSeconds) ? { stage, maxSeconds } : { stage });
}

// What a line of a start's output reports: { stage, maxSeconds }, or null for any other line.
function readStartupMarker(line) {
  const text = String(line).trim();
  if (!text.startsWith('{')) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Object.hasOwn(value, 'ok')) return null;
  if (!Object.hasOwn(STAGE_TEXT, value.stage)) return null;
  return { stage: value.stage, maxSeconds: Number.isInteger(value.maxSeconds) ? value.maxSeconds : null };
}

// Set by a desktop client on the start it runs: it renders the phase itself, so
// its CLI writes the marker instead of prose. It never reaches the services a
// start leaves running (withoutStageMarkers).
const STAGE_MARKER_ENV = 'FULI_STAGE_MARKERS';

export function wantsStageMarkers(env) {
  return env?.[STAGE_MARKER_ENV] === '1';
}

// The environment to hand to a process that outlives the start.
export function withoutStageMarkers(env) {
  if (!env || !Object.hasOwn(env, STAGE_MARKER_ENV)) return env;
  const { [STAGE_MARKER_ENV]: _asked, ...rest } = env;
  return rest;
}

// How a start reports its phase on stdout: the person's sentence in a
// terminal, the marker line when a client is reading along.
export function startupStageWriter(write, env = process.env) {
  const markers = wantsStageMarkers(env);
  return (stage, bound) => write(markers ? startupStageMarker(stage, bound) : startupStageLine(stage, bound));
}

// Calls back with each phase a start's output reports, line by line, as the
// lines arrive (a desktop controller reading the CLI it runs).
export function followStartupStages(stream, onStage) {
  if (!stream) return;
  let rest = '';
  stream.setEncoding?.('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      const marker = readStartupMarker(line);
      if (marker) onStage(marker.stage, { maxSeconds: marker.maxSeconds });
    }
  });
}
