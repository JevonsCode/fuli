# Local knowledge recovery

Judgment records, role work packages and role suggestion records may contain knowledge text. Each FULI
process verifies the deletion ledger before reading that text or changing these
stores. An unavailable personal Provider leaves access closed; waiting does not
make the stores safe automatically.

Start the local console, or run this command against the same data directory:

```sh
fuli migrate reconcile-knowledge --data-dir /path/to/fuli-data
```

The command resumes previously confirmed deletions and cleans local copies. It
does not initiate a new deletion. Exit status zero means the local ledger and
current graph deletion watermark agree and recorded local cleanup has completed. A pending result exits nonzero; restore
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
deletion but local cleanup is unfinished, all three text stores for that space remain
closed. Other spaces retain their independent proof. Identical opaque IDs in
different spaces do not share a fence.

Closed HTTP operations return `503` with `knowledge_recovery_pending`; MCP reports
the same structured code. Counts, IDs and status can still be inspected, and the
console's privileged cleanup remains available. No recovery tool or deletion
enumeration is added to the Agent tool list or chat schema.

Reconciliation also reapplies completed deletions with their original deletion
time. Restoring an old local database beside a current ledger must not restore
deleted words. Cleanup never advances that cutoff to the current time.

Source deletions retain only the source application and session identity alongside
their opaque deletion IDs. A role that started reading a source session before a
deletion cannot save a late suggestion from that session: its final write checks
the generation while holding the same ledger lock used to begin deletion.

Public submission reserves its local draft before sending text. A fresh
reservation blocks source deletion; a timed-out or uncertain result can be
reconciled by metadata lookup. If the result remains unknown, the deletion
preview explains that the remote project may already have the text. Deleting
clears local copies and cannot retract remote public content.

Submission eligibility is checked before reserving a draft. After reservation,
the host records whether it entered the remote call. An expired reservation can
return to pending with `delivery_not_started: true` only for the same attempt,
without a proposal identity, and only when uncertainty came from TTL expiry.
Uncertainty recorded after a remote error cannot use that release path. Deleted
or completed drafts never return to pending through it.

Episode and session deletion also clears directly bound Agent working-memory
revisions. Session matching uses the exact source application and session tuple;
episode matching uses its task token and checkpoint identity. Deleting a knowledge
item does not expand this rule to its supporting episodes. Earlier revisions and
other scopes remain unchanged. Later revisions from other sessions are retained
unless the person selects their scope group in the preview.

Cleared checkpoints retain their identity, time and revision with `memory: null`
and `memory_state: scrubbed`. The head revision does not move backward. Reads and
exports explain the deletion and the expected revision for a new write; they
never substitute an earlier revision. Deleted source sessions and replayed
scrubbed checkpoints cannot write the old text back. A running model may already
hold words in its context; this does not promise to prevent newly rewritten text.

The console and maintenance CLI immediately rewrite affected generated Agent
`MEMORY.md` files, including project layers. The ledger stores only the affected
Agent/project identities and exact revision numbers. Cleanup keeps its revision
fence under the same directory lock as snapshot writes, so a delayed old read
cannot restore selected revisions. Unselected revisions and other files remain
unchanged. A busy, unsafe or unverifiable snapshot keeps the deletion
`local_pending`; it cannot report complete while this cleanup remains unfinished.
Reconciliation obtains the same scopes from graph checkpoint deletion markers
and reapplies cleanup after an independent local snapshot restore.
