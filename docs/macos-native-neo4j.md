# macOS native Neo4j assets

Fuli uses its existing npm/CLI native runtime, external instance data directories,
and pinned Neo4j Community 5.26.28 Unix distribution. There is no macOS application
installer in this workflow. Java 21 must already be installed and match the host
architecture (arm64 or x64); these commands never install or upgrade Java.

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

User rollback selects only the retained same-version assets with their recorded
file fingerprint and identical store-format metadata. It preserves database writes
made after the update. It never loads a database backup, migrates or downgrades a
store. Changed/unknown versions or formats block rollback.

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
`neo4j-transaction.json`. Ordinary setup/start refuses them. Inspect the recorded
old/new descriptors, actual process groups, listeners and offline store formats
before manually completing recovery. Do not delete a lock merely because it is
old. Recovery never copies or overwrites a database. Crash/power-loss recovery is
an explicit operator step; there is no automatic database rollback.

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
