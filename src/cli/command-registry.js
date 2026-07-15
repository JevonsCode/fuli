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

export function dispatchCommand(app, command, args) {
  const handler = COMMANDS[command];
  if (!handler) throw new Error(`Unknown command: ${command}`);
  return handler(app, args);
}

export function isRegisteredCommand(command) {
  return command === '--help' || command === '-h' || Object.hasOwn(COMMANDS, command);
}

export function isCliCommand(command) {
  return command === 'setup' || command === 'migrate' || isRegisteredCommand(command);
}

export function printHelp() {
  console.log(`fuli [--db SQLITE_DB] [--personal-space 我] <command>

Global options must appear before the command.

Commands:
  setup [--yes] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--skip-agents] [--no-start]
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
