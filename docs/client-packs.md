# Updating client descriptor packs

FULI's npm package always supplies the Codex, Claude Code, Cursor and OpenCode
descriptors. The active descriptor decides what FULI's installer manifest asks
agent-installer to write into that client (`src/agent-kits/pack-manifest.js`); FULI
writes no client file itself. No manifest is downloaded automatically.
A person may pin an exact HTTPS or local manifest in the local runtime configuration:

```
fuli clients trust ./manifest.json --sha256 <64 lowercase hex characters>
fuli clients update --check
fuli clients update --apply codex@1.1.0
fuli clients status
fuli clients rollback codex
```

All commands accept `--data-dir DIR`. The runtime must already be configured before
trusting a manifest. Trust asks for confirmation, never renews a pin automatically,
and checks raw manifest bytes. A manifest contains `schemaVersion: 1` and `entries`:

```
{"schemaVersion":1,"entries":[{"id":"codex","version":"1.1.0","sha256":"<pack-file-sha256>","source":"codex.json"}]}
```

Pack sources are HTTPS URLs or paths relative to a local manifest directory.
Remote manifests require HTTPS pack URLs. Local paths cannot escape their manifest
directory. Each pack must pass both its manifest byte digest and its internal descriptor
digest. Existing descriptor validation still limits the manifest mapping (`configWriter`)
and MCP fields. An override
must retain its built-in `configWriter`, `command` and `schemaVersion`. A newer npm
built-in automatically takes precedence; `clients status` reports retired overrides.

`update` and `update --check` only validate and preview descriptors in memory. They
never write client files or storage. Unavailable sources or no newer pack are no-ops.
`--apply` shows the complete built-in and proposed descriptors and asks to install,
then makes the pack active. For a client FULI is in, it shows agent-installer's plan
with the new pack (each changed file and its diff) and asks before agent-installer
writes it; agent-installer backs up every file under `backups/agents/` in the data
directory first and keeps unrelated entries. Every answer defaults to no; `--yes`
bypasses none of these questions. Noninteractive invocations decline confirmation. A
declined or unavailable write leaves the client as it was: the pack stays active and
the next `fuli setup` (or the console's reconnect) updates the client.

Versions and the operation ledger live in the version-guarded `client-packs.json` in
FULI's data directory. Rollback uses the same review and confirmation, never going below
the installed npm descriptor. Commands never launch, stop or signal a client or invoke a
model. The trust and apply commands are CLI-only. Ledger entries an earlier FULI left
`pending` (when it still wrote client files itself) are kept as history; agent-installer
rewrites FULI's entries in full on the next connection, so they need no recovery.
