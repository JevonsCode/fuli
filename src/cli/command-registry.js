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
  start [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--allow-provider-downgrade] [--data-dir DIR] [--personal-space NAME]  (checks Agent setup)
  stop [--data-dir DIR]
  restart [--port PORT] [--open] [--lan|--no-lan] [--rebuild] [--data-dir DIR] [--personal-space NAME]
  status [--json] [--data-dir DIR] [--port PORT]
  open [--data-dir DIR]

Install and Agent connection:
  connect [--format standard|vscode|server] [--data-dir DIR | --runtime-config FILE]  (print generic MCP configuration)
  mcp [--runtime-config FILE] [--source-application codex|claude|claude_code|cursor|kiro|other]  (stdio server)
  setup [--yes] [--codex-only] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--runtime-mode container|native] [--memory-profile low|balanced] [--adaptive-memory|--no-adaptive-memory] [--skip-agents] [--no-start] [--allow-provider-downgrade] [--personal-only|--with-dev-public]
  connect-workspace --url URL --token-file FILE [--data-dir DIR]
  peer status|host|invite|join|share|revoke|off [--data-dir DIR]  (LAN roundtable Beta: pair devices and share project leads)
  remote-mcp --personal-project-id ID --bearer-token-file FILE [--port PORT] [--data-dir DIR] [--source-application claude|cursor|other] [--allowed-origin HTTPS_ORIGIN] [--allowed-host HOST] [--max-sessions N] [--session-idle-ttl-seconds N]
  employee install BUILT_PACKAGE_DIRECTORY [--replace] [--runtime-config FILE]
  app list [--agent AGENT_ID] | show APP_ID | approve APP_ID VERSION | disable APP_ID | rollback APP_ID VERSION  (Agent apps; approve and rollback ask in this terminal)
  app delete APP_ID [--data [--output DIR]] | export APP_ID --output DIR  (delete code first, data second) [--runtime-config FILE]
  models set-key SECRET_REF [--data-dir DIR]  (built-in Agent model API key; hidden entry or stdin, never echoed)
  models check assistant|bole|jefa|tonborg [--data-dir DIR]  (synthetic connection check of one role's model backend)
  worker dispatch --bindings FILE [--runtime-config FILE]  (trusted local host; pipe {plan, idempotencyKey} on stdin)
  update [setup options]  (already latest: no restart; otherwise refresh existing connections only)
  setup --connected-only [setup options]  (repair existing connections without adding clients)
  uninstall [--yes] [--data-dir DIR]

Data formats:
  migrate status [--json] [--data-dir DIR]  (every store's format version, ledger and pending steps; read only, safe while FULI runs)

Graph data portability:
  graph export --output DIR [--mode container|native] [--data-dir DIR]
  graph import --input DIR [--target-mode container|native] [--yes] [--data-dir DIR]
  graph runtime install|update|rollback|uninstall [--preview] [--yes] [--data-dir DIR]  (macOS native assets; preserves data)
  graph migrate --to native [--yes] [--data-dir DIR]  (container graph -> native, count-verified, switches back on failure)`);
}
