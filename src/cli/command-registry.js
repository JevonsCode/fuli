const LOCAL_RUNTIME_COMMANDS = new Set(['start', 'stop', 'restart', 'status', 'open']);

export function isLocalRuntimeCommand(command) {
  return LOCAL_RUNTIME_COMMANDS.has(command);
}

export function printHelp() {
  console.log(`fuli <command>  (short alias: fl)

General:
  --help, -h
  --version, -v

Local service:
  start [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  stop [--data-dir DIR]
  restart [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  status [--json] [--data-dir DIR] [--port PORT]
  open [--data-dir DIR]

Install and Agent connection:
  setup [--yes] [--codex-only] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--skip-agents] [--no-start] [--personal-only|--with-dev-public]
  update [setup options]
  uninstall [--yes] [--data-dir DIR]`);
}
