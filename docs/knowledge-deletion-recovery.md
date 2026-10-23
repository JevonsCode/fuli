# Local knowledge recovery

Judgment records and role work packages may contain knowledge text. Each FULI
process verifies the deletion ledger before reading that text or changing these
stores. An unavailable personal Provider leaves access closed; waiting does not
make the stores safe automatically.

Start the local console, or run this command against the same data directory:

```sh
fuli migrate reconcile-knowledge --data-dir /path/to/fuli-data
```

The command resumes previously confirmed deletions and cleans local copies. It
does not initiate a new deletion. Exit status zero means the local ledger and
current graph deletion watermark agree. A pending result exits nonzero; restore
Provider availability and retry. Successful `fuli setup` performs this check too.

The console and maintenance CLI alone reconcile deletion records through the
human-review channel. An Agent process receives only the aggregate count and
latest deletion time, never a list of deleted items. Its read-only gate caches a
successful graph check for at most 60 seconds and invalidates it immediately when
the local ledger changes. The final storage operations also check the gate.

The ledger is version 2, with a schema fingerprint and per-space watermarks. A
version 1 ledger remains readable, but has no synchronization proof; reconciliation
preserves its operations and writes the current format. Corrupt, unknown-version,
missing-proof, or restored-old ledgers fail closed. A missing ledger can open only
when the graph confirms that the space has no recorded deletions.

An operation with an unknown graph outcome fences only its referenced items.
Reads hide those items' text without rewriting history. Once the graph confirms
deletion but local cleanup is unfinished, both text stores for that space remain
closed. Other spaces retain their independent proof. Identical opaque IDs in
different spaces do not share a fence.

Closed HTTP operations return `503` with `knowledge_recovery_pending`; MCP reports
the same structured code. Counts, IDs and status can still be inspected, and the
console's privileged cleanup remains available. No recovery tool or deletion
enumeration is added to the Agent tool list or chat schema.
