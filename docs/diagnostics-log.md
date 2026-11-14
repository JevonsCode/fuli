# Diagnostics log

FULI records its own runtime failures in one local, size-capped event log so that the person, or an Agent working
for them, can see what went wrong without being shown a raw error. This page states exactly what the log covers and
what it does not.

## Where it lives and how big it gets

- `<data directory>/diagnostics/events.jsonl`, one JSON object per line, never changed after it is written.
- Past 1 MB the file becomes `events.jsonl.1`, older copies move to `.2` and `.3`, and the previous `.3` is deleted. The
  log never holds more than four files of about 1 MB each.
- Rotation runs under a cross-process lock. When another process holds it, the file keeps growing up to a hard cap of
  1.25 MB per file and then takes no more events until rotation succeeds.
- Files are private to your account (mode 0600, directory 0700 where the OS supports it). Nothing is sent to the
  graph, the network or any server.
- `fuli migrate status` lists the log as store `diagnostics` (kind `jsonl`). It is inspected only: never migrated,
  backed up or restored. Each line carries its own version (`v`), and a line this FULI cannot read is skipped and
  counted.

## What one event says

| Field | Meaning |
| --- | --- |
| `at` | Local time with its UTC offset, for example `2026-11-05T14:03:00.120+08:00` |
| `component` | `hook`, `http`, `provider`, `mcp` or `roundtable` |
| `version` | The FULI version that wrote it |
| `operation` | What was being done: `codex.Stop`, `GET /api/…` (path only), a tool name, `native.start` |
| `outcome` / `level` | `failed` / `error` (FULI could not do it) or `refused` / `warning` (FULI answered with an error the caller can act on) |
| `code` | A fixed error code or class, such as `provider_not_ready` or `invalid_input` |
| `reason` | A short, redacted sentence of at most 240 bytes |
| `durationMs` | Optional: how long the operation ran before it failed |
| `correlationId` | Optional: the client session the failure belongs to |

The `reason` comes only from a FULI error written for its caller or from a fixed sentence. A raw exception message is
never stored, because it may contain a path, a prompt or a secret. Every text field also passes through the same
redaction FULI uses for knowledge (`src/security/sensitive-content.js`). URL query values are masked (keys kept), URL
user names and passwords are dropped, local paths become `[path]`, and long opaque values such as task tokens become
`[redacted:opaque]`. Prompts, transcripts and knowledge text are never written.

## What is recorded

- **Lifecycle hooks** (Claude Code, Codex, Cursor, OpenCode): a hook run that fails after it has resolved its runtime
  configuration. The event uses the same cause the client was shown, and it is written after the hook has answered.
- **Console HTTP API**: a request that ends in the server's error handler (5xx, and 4xx errors thrown by a route).
- **Native Graph Provider start**: a start that fails because the Provider process exited during startup
  (`provider_exited`), never became ready (`provider_not_ready`) or is incompatible (`provider_incompatible`), or
  because the native services otherwise did not start.
- **MCP tool calls**: a tool call that throws, as `refused` with the tool's own code or as `failed` with
  `internal_error`. A `failed` reason names the error's class, its cause's code and the first line of FULI's own code
  that raised it (`Tool execution failed (TypeError at src/…/module.js:51)`), never its message.
- **Roundtable wakes**: a client woken for an ask (a local one or a paired device's) that did not answer, as `failed`
  with its detail code (`client_not_found`, `spawn_error`, `login_required`, `client_exit_nonzero`,
  `no_final_answer`, `output_too_large`, `timed_out`), the client, a resumed or new session, and the exit code and
  signal. The client's own output is never written here; a redacted summary of at most 600 characters stays in the
  roundtable store of the computer where it ran. A cancelled wake is not recorded.

Writing an event is a single synchronous append of under 1 KB that catches every error. It never fails, delays or
changes the operation it describes. When the data directory does not exist, nothing is written and nothing is
created.

## What is not recorded

- A **hard power loss** or OS crash, or a process **killed before it wrote** its event (for example a hook that hits
  its client's deadline and is terminated). Such a failure leaves no event.
- Failures outside the five places above, including a hook that fails before it can find its runtime configuration.
- 4xx answers a route sends directly without raising an error (for example a plain 404 or 405).
- A Provider that exits **after** it started successfully. Only startup is watched.
- Events refused at the hard cap while rotation was blocked, and events removed when `.3` is rotated out.
- Successful operations, timings of successful operations, and warnings that did not fail anything.

An empty answer therefore does not prove that FULI is healthy. Every answer repeats this in `notCovered`.

## Reading it

All three readers use the same filters and return the same answer: `from` / `to` (ISO 8601), `component`, `level`,
`code`, `limit` (1–100, default 50) and `cursor`. Events come newest first. The answer includes:

- `total` and `counts` grouped by component, level and code, over every match and not just the page (at most 50
  codes, with `codesOmitted` for the rest);
- `nextCursor` for the next page;
- `truncated` and `truncatedBy`: `page` when more events match, `retention` when rotation already dropped events
  inside the requested range;
- `retainedFrom`, the oldest kept event;
- `sourcesUnavailable`, files that exist but could not be read, and `skippedLines`;
- `stored`, whether any log file exists.

The readers are:

- **HTTP**: `GET /api/diagnostics/events?component=provider&limit=20` on the local console. Only loopback requests are
  answered (others get 403 `local_user_only`).
- **Agent tool**: `read_diagnostic_events`, a read-only full-profile tool. A chat-profile Agent reads its schema with
  `list_agent_interfaces("read_diagnostic_events")` and calls it with `fuli_call`.
- **CLI**: `fuli diagnostics [--from ISO] [--to ISO] [--component …] [--level …] [--code CODE] [--limit N]
  [--cursor C] [--json] [--data-dir DIR]` reads the files directly, so it works while the console or MCP server is
  down. It exits with code 2 when a log file could not be read.
