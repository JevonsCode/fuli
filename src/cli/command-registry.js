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
  start [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--data-dir DIR] [--personal-space NAME]  (checks Agent setup)
  stop [--data-dir DIR]
  restart [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  status [--json] [--data-dir DIR] [--port PORT]
  open [--data-dir DIR]

Install and Agent connection:
  setup [--yes] [--codex-only] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--runtime-mode container|native] [--memory-profile low|balanced] [--adaptive-memory|--no-adaptive-memory] [--skip-agents] [--no-start] [--personal-only|--with-dev-public]
  connect-workspace --url URL --token-file FILE [--data-dir DIR]
  update [setup options]
  uninstall [--yes] [--data-dir DIR]

Graph data portability:
  graph export --output DIR [--mode container|native] [--data-dir DIR]
  graph import --input DIR [--target-mode container|native] [--yes] [--data-dir DIR]`);
}
