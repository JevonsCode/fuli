import { parseArgs } from 'node:util';

import { diagnosticEventLog } from '../diagnostics/event-log.js';
import { diagnosticEventsAnswer } from '../diagnostics/query.js';
import { resolveSetupPaths } from '../setup/paths.js';
import { writeLine } from './terminal-io.js';

// `fuli diagnostics` (rec#73): FULI's runtime failures read straight from the
// data directory's diagnostics files, so it works while the console is down.
// The same filters and answer as GET /api/diagnostics/events. Read only.

const USAGE = 'Usage: fuli diagnostics [--from ISO] [--to ISO] [--component hook|http|provider|mcp] '
  + '[--level error|warning] [--code CODE] [--limit N] [--cursor CURSOR] [--json] [--data-dir DIR]';
const FILTERS = ['from', 'to', 'component', 'level', 'code', 'limit', 'cursor'];
const OPTIONS = Object.freeze({ ...Object.fromEntries(FILTERS.map((name) => [name, { type: 'string' }])),
  json: { type: 'boolean' }, 'data-dir': { type: 'string' } });
const UNREADABLE_EXIT_CODE = 2;

export async function runDiagnosticsCommand(args, dependencies = {}) {
  const options = parseDiagnosticsOptions(args);
  const env = dependencies.env ?? process.env;
  const write = dependencies.write ?? writeLine;
  const { dataDir } = (dependencies.resolvePaths ?? resolveSetupPaths)({ dataDir: options['data-dir'] ?? null, env });
  const answer = diagnosticEventsAnswer(diagnosticEventLog(dataDir),
    Object.fromEntries(FILTERS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]])));
  write(options.json ? JSON.stringify(answer, null, 2) : formatDiagnostics(answer));
  return { exitCode: answer.sourcesUnavailable.length ? UNREADABLE_EXIT_CODE : 0, answer };
}

function parseDiagnosticsOptions(args) {
  try {
    return parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new TypeError(`${USAGE}\n${error.message}`);
  }
}

export function formatDiagnostics(answer) {
  const lines = [answer.stored
    ? `${answer.total} matching event${answer.total === 1 ? '' : 's'}, newest first`
      + `${answer.retainedFrom ? ` (kept since ${answer.retainedFrom})` : ''}.`
    : 'No diagnostic events are stored in this data directory yet.'];
  for (const event of answer.events) {
    lines.push([event.at, event.level, event.component, event.operation, event.code ?? '-',
      event.durationMs === undefined ? null : `${event.durationMs} ms`, event.correlationId ?? null]
      .filter((part) => part !== null).join('  '));
    if (event.reason) lines.push(`    ${event.reason}`);
  }
  const counts = Object.entries(answer.counts.code).map(([code, count]) => `${code} ${count}`).join(', ');
  if (counts) lines.push(`By code: ${counts}${answer.counts.codesOmitted ? `, ${answer.counts.codesOmitted} more` : ''}`);
  if (answer.truncatedBy.includes('page')) lines.push(`More events match; next page: --cursor ${answer.nextCursor}`);
  if (answer.truncatedBy.includes('retention')) {
    lines.push('Older events were dropped by rotation, so the requested range may be incomplete.');
  }
  for (const { source, reason } of answer.sourcesUnavailable) lines.push(`Could not read ${source} (${reason}).`);
  if (answer.skippedLines) lines.push(`${answer.skippedLines} unreadable or newer-format lines were skipped.`);
  lines.push(answer.notCovered);
  return lines.join('\n');
}
