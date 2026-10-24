# Agent apps

An Agent app is a small tool, page or resident service that a FULI Agent builds for a real, repeated need. An Agent can
only submit an immutable version (`submit_agent_app_version`) and read the list (`list_agent_apps`). Approving,
rolling back, disabling and deleting belong to the local user, in a terminal (`fuli app`) or the local console.

## Trusted mode: no sandbox in this version

This version has no system sandbox. **An approved app runs in trusted mode: as an ordinary process of your own OS
account, with your account's permissions. FULI does not isolate it.** This is the same footing as an installed
[Agent workbench package](employee-agents.md), which is trusted JavaScript running with the host's privileges. Approve
only apps you trust.

Approval shows one warning:

> 这个应用会用你的账户权限在本机运行，FULI 不会隔离它。只批准你信任的应用。
> This app runs on this computer with your account's permissions, and FULI does not isolate it. Approve only apps you trust.

### What FULI's fences cover, and what they do not

FULI's tool allowlist (an app is never granted a tool marked egress, model or launch, nor any tool that grows or
manages apps), its permission checks, its egress checks, its injection isolation and its hard-delete fence apply
**only to what an app asks of the FULI Host API**: the calls it makes through its app token, its data directory port
and the scope FULI injects into each call.

They do **not** stop a trusted app from reading or writing files, using the network or starting processes by itself.
Nothing in FULI is a system isolation of trusted code, and nothing in FULI should be read as one. A refused
`network` field in a manifest means the FULI host grants no network access; it does not mean the app has none.

Sandboxed runners (AppContainer on Windows, bwrap on Linux, sandbox-exec on macOS) are planned for a later version
(rec#37); they will plug into the same runner contract (`src/agent-apps/trusted-runner.js`).

## Approving: the terminal confirmation flow

```bash
fl app list
fl app show <app-id>
fl app approve <app-id> <version> [--hello]
fl app rollback <app-id> <version> [--hello]
```

`approve` and `rollback` work the same way on Windows, macOS and Linux, and only in an interactive terminal:

1. A resident service and an irreversible data migration each get their own yes/no question first.
2. FULI shows the app name, a short summary of this version's terms (package digest, permissions, data directory,
   resident service), the trusted-mode warning above and this notice:
   > 输入应用名即完成终端确认流程。这不证明是真人操作，也不能抵御以同一账户运行的其他程序。
   > Typing the app name completes the terminal confirmation flow. This does not prove a person did it, and it does not
   > protect against other programs running under the same account.
3. You type the app name (the package name, for example `dispatch-log`) to confirm. Enter on an empty line or Ctrl-C
   cancels.

Each attempt uses a one-time challenge that expires after 10 minutes. It binds the exact action, the package digest,
the terms version and `trustMode: 'trusted'`. It is committed in two steps (claim, then finalize), so of concurrent
attempts exactly one can approve. A wrong name, a cancellation, an expired challenge, a replay, or terms or a package
that changed after the prompt approves nothing and leaves the challenge used.

`--hello` adds Windows Hello on Windows after the name is typed, and records the approval as presence `hello`. It is
optional and never required; if you ask for it and Hello fails or is cancelled, that decision is refused. Other
platforms have no `--hello`.

An approval from the local console completes no terminal confirmation, so the run gate refuses that version until
`fl app approve` or `fl app rollback` confirms it.

## When an app runs

Every start of an app (on demand, an idle restart, a resident launch) passes the run gate. It runs only when:

- the active version has an approval that completed the terminal confirmation flow under this version's terms
  (`trustMode: 'trusted'`, the current terms version), recorded with its consumed challenge;
- that approval covers the version's digest, permissions, data scope and resident service;
- the package on disk still has the approved digest.

Otherwise the gate answers `confirmation_required`, `reconfirmation_required` or `challenge_mismatch`, and no app code
starts. The app process gets only `FULI_APP_ID`, `FULI_APP_INSTANCE` and `FULI_APP_TOKEN` from FULI, plus the
platform basics (`PATH`, temp and home directories); none of FULI's own tokens or keys. It runs in its package
directory and ends when the FULI process that started it exits.

## After upgrading from an earlier FULI

Approvals made before trusted mode (the isolated mode of the previous version, Windows Hello approvals included) are
**not** converted. Consent to code that was to run isolated is not consent to run it with your own permissions. The
registry migrates by itself (format 8 adds the trust mode and terms version to each approval; the earlier ones keep
none), and each such version answers `reconfirmation_required` until you confirm it again:

```bash
fl app rollback <app-id> <active-version>
```

## Stopping

When FULI itself shuts down, it takes no new start, call or decision, lets work in flight finish (30 seconds at most),
then seals and stops every app it started and releases them, so another FULI process can start them without a takeover.
A start that returns after that is stopped at once. If FULI cannot confirm that an app process it started has stopped,
the shutdown says so and names the app instead of reporting a clean close; closing again retries the stop.

An app that ends by itself ends its instance. The app's details show the exit code, the signal and one of three fixed
categories with a fixed message: `load_failed` (it ended before its entry finished loading), `crashed` (it ended with
an error after that) or `exited` (it finished with code 0). FULI does not read or keep anything the app writes to its
output. It can then be started again.

An entry has finished loading once its module, including any top-level `await`, has settled. An entry whose top-level
`await` never settles (a server loop awaited at the top level, for example) never counts as loaded, so a later crash is
labelled `load_failed`. Finish top-level initialization promptly and keep long-running work in callbacks, timers or
servers that keep the process alive.

`fl app stop <app-id>` seals the instance (no new call verifies; a write tool in progress finishes first), stops the
app process through the handle FULI holds and ends its tokens. `--force` is not supported on any platform in this
version: when another FULI process holds the app, stop that FULI process first. FULI never ends a process by PID; if
an app process an exited FULI started is still running, end it yourself and try again.
