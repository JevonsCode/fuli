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
  clients trust|update|status|rollback [--data-dir DIR]  (pinned descriptor packs; update previews; apply asks separately for each file)
  connect [--format standard|vscode|server] [--data-dir DIR | --runtime-config FILE]  (print generic MCP configuration)
  mcp [--runtime-config FILE] [--source-application codex|claude|claude_code|cursor|kiro|opencode|other]  (stdio server)
  setup [--yes] [--codex-only] [--data-dir DIR] [--personal-space NAME] [--port PORT] [--runtime-mode container|native] [--memory-profile low|balanced] [--adaptive-memory|--no-adaptive-memory] [--skip-agents] [--no-start] [--allow-provider-downgrade] [--personal-only|--with-dev-public]
  connect-workspace --url URL --token-file FILE [--data-dir DIR]
  peer status|host|invite|join|share|revoke|off [--data-dir DIR]  (LAN roundtable Beta: pair devices and share project leads)
  remote-mcp --personal-project-id ID --bearer-token-file FILE [--port PORT] [--data-dir DIR] [--source-application claude|cursor|other] [--allowed-origin HTTPS_ORIGIN] [--allowed-host HOST] [--max-sessions N] [--session-idle-ttl-seconds N]
  employee install BUILT_PACKAGE_DIRECTORY [--replace] [--runtime-config FILE]
  app list [--agent AGENT_ID] | show APP_ID | approve APP_ID VERSION | disable APP_ID | rollback APP_ID VERSION  (Agent apps; approve and rollback ask in this terminal, then Windows Hello)
  app delete APP_ID [--data [--output DIR]] | export APP_ID --output DIR  (delete code first, data second) [--runtime-config FILE]
  models set-key SECRET_REF [--data-dir DIR]  (built-in Agent model API key; hidden entry or stdin, never echoed)
  models check assistant|bole|jefa|tonborg [--data-dir DIR]  (synthetic connection check of one role's model backend)
  session start|stop|restart|status [--client claude_code|codex] [--json]  (FULI for the client session this runs in, e.g. "!fuli session stop" in Claude Code or Codex)
  session default on|off|status [--json]  (whether new sessions start with FULI on; open sessions keep theirs)
  worker dispatch --bindings FILE [--runtime-config FILE]  (trusted local host; pipe {plan, idempotencyKey} on stdin)
  update [setup options]  (already latest: no restart; otherwise refresh existing connections only)
  setup --connected-only [setup options]  (repair existing connections without adding clients)
  uninstall [--yes] [--data-dir DIR]

Data formats:
  migrate reconcile-knowledge [--data-dir DIR]  (resume confirmed knowledge deletion cleanup and verify local recovery)
  migrate status [--json] [--data-dir DIR]  (every store's format version, ledger and pending steps; read only, safe while FULI runs)
  migrate preview [--json] [--data-dir DIR]  (the steps waiting for you: stores, step IDs, counts, sample IDs and a plan digest; read only)
  migrate apply --digest DIGEST [--data-dir DIR]  (applies exactly that previewed plan after you confirm at this terminal; backs up first)
  migrate rollback --store LABEL --migration ID [--data-dir DIR]  (undoes one confirmed migration if nothing it changed was changed since)
  migrate restore --store LABEL [--backup REF] [--data-dir DIR]  (replaces a whole store with a backup, losing later changes; FULI stopped)
  migrate prune [--keep N] [--max-mb MB] [--dry-run] [--data-dir DIR]  (format backups by retention policy; never one an undo or the current version needs)

Graph data portability:
  graph export --output DIR [--mode container|native] [--data-dir DIR]
  graph import --input DIR [--target-mode container|native] [--yes] [--data-dir DIR]
  graph runtime install|update|rollback|uninstall [--preview] [--yes] [--data-dir DIR]  (macOS native assets; preserves data)
  graph migrate --to native [--yes] [--data-dir DIR]  (container graph -> native, count-verified, switches back on failure)`);
}
