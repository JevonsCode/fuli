# Updating client descriptor packs

FULI's npm package always supplies the Codex, Claude Code and Cursor descriptors.
The other five code adapters remain reserved. No manifest is downloaded automatically.
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
digest. Existing descriptor validation still limits writers and MCP fields. An override
must retain its built-in `configWriter`, `command` and `schemaVersion`. A newer npm
built-in automatically takes precedence; `clients status` reports retired overrides.

`update` and `update --check` only validate and preview descriptors in memory. They
never write client files or storage. Unavailable sources or no newer pack are no-ops.
`--apply` shows the complete built-in and proposed descriptors and asks to install.
For an existing client connection, it renders through the existing config writers,
shows each changed file's full before/after content and backup path, and asks separately
before writing that file. Every answer defaults to no; `--yes` bypasses none of these
questions. Noninteractive invocations decline confirmation. Unrelated entries survive.

Versions and the operation ledger live in the version-guarded `client-packs.json` in
FULI's data directory. Failed writes restore files already attempted and retain the
previous active version, recording failure in the ledger. Backups remain under
`backups/client-packs/`. Rollback uses the same file review and confirmation, never
going below the installed npm descriptor. Commands never launch, stop or signal a
client or invoke a model. The trust and apply commands are CLI-only.

Before writing any client file, apply durably saves every backup and a pending
operation journal while keeping the previous active version. If the process is
interrupted, `clients status` reports `recoveryRequired` and another apply refuses
to proceed. Run `clients rollback ID` to review and restore the interrupted files.
Recovery verifies backup digests and refuses files edited since the interrupted
write. Declining recovery leaves the journal pending; it never silently resumes.
