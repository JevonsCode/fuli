# macOS native Neo4j assets

Fuli uses its existing npm/CLI native runtime, external instance data directories,
and pinned Neo4j Community 5.26.28 Unix distribution. Java 21 must already be installed and match the host
architecture (arm64 or x64); these commands never install or upgrade Java. The macOS
app (`docs/macos-app.md`) brings its own Java 21 and installs Neo4j from the archive
it ships, into the same managed directories.

```sh
fuli graph runtime install --preview
fuli graph runtime install --yes
fuli graph runtime update --preview
fuli graph runtime update --yes
fuli graph runtime rollback --preview
fuli graph runtime rollback --yes
fuli graph runtime uninstall --preview
fuli graph runtime uninstall --yes
```

All commands accept `--data-dir DIR`. Without `--yes`, a mutation asks for terminal
confirmation. Install delegates the existing native setup with client integration
changes disabled. Existing container data needs its separate explicit migration.

Installation verifies the pinned public archive SHA-256, extracts to a temporary
sibling, checks executable files and publishes a complete version directory by
rename. It does not delete an existing partial/user-modified version directory.
Verified downloads can be reused after extraction failure. Interrupted download
partials remain resumable. An installation lock prevents concurrent publishers.

Update prepares a fresh immutable copy in `native-runtime/neo4j-assets` before
stopping the console and owned graph services. If a console is running, a read-only
preflight first requires the current packaged runtime to be reusable without
Provider installation or manifest refresh; otherwise a separate setup is required
before any staging or shutdown. This asset operation never upgrades the Provider. Setup, service start/stop, offline
admin operations, update, rollback and removal share one exclusive operation
lease. Previously created service descriptors cannot start after a switch.
The manifest switches atomically. Real PID/process-group ownership is checked for
both Neo4j ports; an authenticated component query must report the pinned version.
Offline `neo4j-admin database info` records the format of every managed store.

When the installed Neo4j is an older patch of the pinned version (same major.minor),
setup and start keep using it; only `update` upgrades it. After the old services
stop and before the newer Neo4j opens the store, update backs up the graph with the
`fuli graph export` mechanism into `backups/graph/before-neo4j-<version>-<time>`,
using the installed Neo4j. A failed backup switches nothing. A newer or other-minor
installed version is refused.

User rollback selects only the retained same-version assets with their recorded
file fingerprint and identical store-format metadata. It preserves database writes
made after the update. It never loads a database backup, migrates or downgrades a
store. Changed/unknown versions or formats block rollback. Rollback after a patch
upgrade is refused: the newer Neo4j may have raised the store's kernel version, and
the older one might not open it. The message names the pre-upgrade backup, which
stays in place; restoring it discards graph changes made since the upgrade.

If a candidate fails, Fuli confirms its process group and listeners have stopped,
checks that the stores still have their original formats, restores the previous
manifest and verifies the previous assets. A failure to stop, concurrent descriptor
change, lock loss or changed store format blocks automatic restoration and keeps
the transaction evidence. A console restart failure first stops the new console.

Removal deletes only owned Neo4j asset generations. Personal/workspace data,
transactions, logs, configuration, credentials and the Provider environment stay
outside those directories and are retained. The runtime stays stopped. A later
install uses the existing external data; removal does not imply data erasure.

An interrupted operation leaves `.neo4j-lifecycle.lock` and/or
`neo4j-transaction.json` (`src/native-runtime/neo4j-lifecycle-lock.js`). The lock
is prepared under a temporary name and renamed into place, so it never appears
without its token and `holder.json`: the process that took it (PID, its start
time and command as `ps` shows them) and the operation (`start`, `stop`,
`update`, `rollback`, `uninstall`, and `dump` / `load` for an offline export or
import).

- A start or stop lock whose holder has ended, or whose PID now runs another
  program, is taken over by the next start when no `neo4j-transaction.json`
  exists: the lock is renamed aside, its token checked, then removed.
- A holder that still runs, including another user's process, keeps the lock.
- An update, rollback, uninstall, dump or load lock is never taken over, nor
  released by `unlock`. An update, rollback or uninstall stops before it changes
  knowledge data but may leave a half-installed `neo4j-assets/jvs-a-*`
  directory; a dump only reads; a load overwrites the database and may leave it
  half written. `fuli graph runtime recover` (below) deals with these.
- A lock that names no holder (taken before FULI recorded one) is released only
  on request: 「解除这把锁并启动」 in the desktop window, or
  `fuli graph runtime unlock`. Both run the same checks and keep the lock, saying
  which check failed, unless no `neo4j-transaction.json` exists, the processes in
  `processes.json` have ended, `neo4j-assets` holds no `jvs-a-*` directory the
  manifest does not use, no other FULI CLI or controller for this data directory
  runs, and the lock is older than 3 × the 30-minute asset download timeout.
  No MCP tool reaches them, and Agents leave them to the person
  (operating-fuli); `unlock --yes` and the desktop controller themselves do
  not check who runs them.
- Take-overs run one at a time (`.neo4j-lifecycle.takeover`), and the lock is read
  again right before it is moved, so a lock replaced since it was judged stays.
  A process killed mid-way leaves `.neo4j-lifecycle.lock.new-*` or `.stale-*`;
  the next lock clears those older than 10 minutes.
- A switch whose own rollback did not finish (it throws "rollback needs
  attention", "Previous assets changed" or "did not start again") keeps its
  journal and its lock; one that rolled itself back removes both.
- `neo4j-transaction.json` means a switch did not finish. Every start, stop and
  asset operation refuses to run until it is recovered with `fuli graph runtime
  recover`. During `switching` the newer Neo4j may already have
  opened the store, which the older one may then not open; an upgrade's graph
  backup is in `backups/graph/before-neo4j-<version>-<time>`, named in the
  journal (`next.previousNeo4jAsset.graphBackup`). During `removing-assets` only
  program files are removed. Recovering a switch or an uninstall never copies or
  overwrites a database; recovering an interrupted load does (below). Recovery
  is an explicit step a person confirms; nothing rolls a database back by itself.

## Recovering an interrupted operation

`fuli graph runtime recover` (`src/native-runtime/neo4j-recovery.js`; in the
desktop window 「恢复并启动」) first prints what it would do and a digest. The
CLI acts only in a terminal (stdin is a TTY), after the prompt or with
`--yes --expect <digest>`; without one only `--preview` runs, and no MCP tool
reaches it. That keeps an Agent's non-interactive shell from recovering; it
does not check who is typing, and the desktop controller (`recover-start
<digest>`, run after the person confirmed in the window) acts for whichever
local process calls it. Agents leave recovery to the person (operating-fuli).
It then acts only if nothing changed since the plan was shown. It refuses while the lock's holder runs, another FULI CLI or
controller works on the data, or the running programs cannot be listed; a lock
that names no holder (with a switch journal) waits the same 90 minutes as
`unlock`. The graph services `processes.json` records are stopped first, under
the lock's own token.

| What was interrupted | What recovery does |
| --- | --- |
| A switch (`switching`), descriptor still the older one | Undo: an update's candidate `jvs-a-*` and the journal move aside, the lock is released |
| A switch, descriptor already the newer one | Finish: the newer Neo4j starts once under the lock's token, answers the health check and stops, the store format must still be the one in the journal; then the journal moves aside. Back out (`--back-out`, or the window's second button): offered only when the journal has the older programs' fingerprint and they still match; it checks the store format, records `backingOut: true` in the journal, writes the older descriptor, starts the older Neo4j once and checks it, and writes the newer descriptor back if it does not start. A check that fails keeps the journal and the lock |
| A back-out killed after it wrote the older descriptor (`backingOut` in the journal) | Continue it, never undo: the newer Neo4j already opened the store, so the older one is started and checked, and the newer descriptor is written back if it does not start |
| A journal whose lock is gone or names no token | The recovery takes a lock of its own (`operation: recover`) and runs the plan under its token; killed after the journal moved, that lock alone is released next time |
| A switch, descriptor neither | Refused (`manifest_changed`) |
| An uninstall (`removing-assets`) | Only when the descriptor is the journal's `previous`, or that with `status: uninstalled`: each remaining program directory, checked to be one FULI manages (`assertManagedNeo4jHome`, or a `jvs-a-*` with FULI's receipt, or one whose receipt the killed removal already took and that holds only that version's programs), moves aside. Runs again after being killed at any step |
| An update, rollback or uninstall before its journal | The programs in use must still match their fingerprint (skipped when the descriptor says `uninstalled`: the lock alone is released); unused `jvs-a-*` directories with FULI's receipt, or an update's own candidate made while its lock was held and killed before its receipt, move aside (anything else: refused, `unknown_assets`); unfinished `backups/graph/before-neo4j-*.partial-*` is renamed `.incomplete` |
| A dump | Release the lock |
| A load | The import records in the lock which copy it took before loading (`restorePoint`: `backups/graph/before-import-*`, the instances it holds, the instances being loaded). Recovery loads that very copy back under the lock's token, moves aside the stores of instances that were empty before the import (no copy: a first import, or `graph migrate` into a new runtime), starts Neo4j once and checks it answers, then releases the lock; a start that fails keeps the lock. A lock without that record, or a copy that is missing, damaged or fails its checksums, is refused (`restore_point_unknown`, `restore_point_damaged`); FULI never picks another copy. What the import was bringing in is not kept |
| A load whose copy cannot be used, abandoned on request | `--abandon-import` in a terminal (typing `abandon`; `--yes` is refused), or 「放弃这次导入…」 in the window: the plan says why the copy cannot be used, that the graphs being imported (every graph when an older lock does not say which) become empty, where their stores go, and lists the `backups/graph/before-import-*` copies with their time, size and `fuli graph import` command (or that there are none). It moves `data/databases/neo4j` and `data/transactions/neo4j` of those instances aside and releases the lock; killed part way, it is planned again from what is left |

The lock stays until its step, so a start is refused while a recovery is
incomplete, and a recovery killed part way is planned and finished again.
Each recovery moves what it sets aside to `native-runtime/recovered/<time>/`
(keeping the paths relative to `native-runtime/`), copies the descriptor there
before writing it, and moves the journal there; `recovered/recovery-<time>.json`
records what it did. The plan lists each move with its size.

What a recovery overwrites or permanently deletes: restoring a load overwrites
the whole graph from that import's own copy; after the lock is released, old
`recovered/<time>/` folders are permanently deleted when at least 3 newer ones
exist and they are over 30 days old (`recovered-dir.js`), each one listed in
the plan with its size first. A folder that cannot be deleted stays, is named
in the result and the record, and never fails the recovery or keeps the lock.
The records are kept. A failed step is recorded in the diagnostics log, and
`fuli diagnostics` names the latest recovery record. The CLI's and the window's
success message point to it too.

## Verification

```sh
node --test test/native*.test.js test/macos-native-ports.test.js test/setup-native-runtime.test.js
# Uses only the public pinned archive and an existing matching Java 21:
FULI_TEST_NEO4J_ARCHIVE=/test-assets/neo4j-community-5.26.28-unix.tar.gz \
  JAVA_HOME=/existing-java-21 node acceptance/macos-native-runtime.js
```

The opt-in acceptance creates a synthetic HOME, database and ephemeral loopback
ports. It checks public-archive installation, actual Neo4j version/queries, the
transactional update, injected health failure/recovery, user rollback, data
retention and removal, then cleans its owned processes and synthetic files.
Controlled unit fixtures are distinct from this real JVM/database acceptance.
Intel macOS logic is covered by unit tests; native Intel hardware is not claimed.

Sources: [Neo4j requirements](https://neo4j.com/docs/operations-manual/current/installation/requirements/),
[official pinned checksum](https://dist.neo4j.org/neo4j-community-5.26.28-unix.tar.gz.sha256),
[offline store information](https://neo4j.com/docs/operations-manual/current/database-internals/neo4j-admin-store-info/).
