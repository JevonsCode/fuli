import { candidate, candidates } from './commands/candidates.js';
import { observe, remember } from './commands/ingestion.js';
import { context, history, rules, search, timeline } from './commands/reads.js';
import { createSpace, subscribe } from './commands/spaces.js';

const COMMANDS = Object.freeze({
  space: createSpace,
  subscribe,
  remember,
  observe,
  search,
  timeline,
  rules,
  history,
  context,
  candidates,
  candidate
});

const LOCAL_RUNTIME_COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'open']);

export function dispatchCommand(app, command, args) {
  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(app, args);
}

export function isRegisteredCommand(command) {
  return command === '--help' || command === '-h' ||
    command === '--version' || command === '-v' ||
    Object.hasOwn(COMMANDS, command);
}

export function isCliCommand(command) {
  return command === 'setup' || command === 'update' ||
    command === 'uninstall' || command === 'migrate' ||
    LOCAL_RUNTIME_COMMANDS.has(command) || isRegisteredCommand(command);
}

export function isLocalRuntimeCommand(command) {
  return LOCAL_RUNTIME_COMMANDS.has(command);
}

export function printHelp() {
  console.log(`fuli <command>  (short alias: fl)

General:
  --help, -h
  --version, -v

Local service:
  start [--port 2727] [--open] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  stop [--data-dir DIR]
  restart [--port 2727] [--open] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  status [--json] [--data-dir DIR]
  open [--data-dir DIR]

Install and Agent connection:
  setup [--yes] [--codex-only] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--skip-agents] [--no-start] [--personal-only|--with-dev-public]
  update [setup options]
  uninstall [--yes] [--data-dir DIR]

Legacy local knowledge commands:
  fuli [--db SQLITE_DB] [--personal-space 我] <command>
  Global options must appear before the command.

Commands:
  space create NAME --kind personal|public
  subscribe PERSONAL_SPACE PUBLIC_SPACE
  remember PERSONAL_SPACE --target SPACE --source-kind prd --text TEXT
  observe PERSONAL_SPACE --target SPACE
  search PERSONAL_SPACE QUERY
  timeline SPACE SUBJECT
  rules SPACE
  history SPACE PREDICATE
  context PERSONAL_SPACE SPACE QUERY
  candidates PERSONAL_SPACE
  candidate CANDIDATE_ID sync|personal_only|ignore
  migrate --from LEGACY_JSON --to SQLITE_DB`);
}
