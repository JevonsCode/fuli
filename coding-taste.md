# Coding Taste

How code in this repository should look, regardless of which Agent writes it. `AGENTS.md` sets the
boundaries; this file sets the habits. When the two disagree, `AGENTS.md` wins.

## 1. Search before you write

Several Agents work in parallel here, so the most common defect is not a bug but a second copy.

- Before adding any helper, search for its behavior, not just its name:
  `git grep -nE "function (requiredString|nonEmpty|canonicalJson)"`, `git grep -n "typeof .* === 'string' && .*trim()"`.
- If an equivalent exists in a sibling module, import it. If it is private, move it to the owning shared
  module (section 3) in the same change and update the existing callers.
- If two copies differ slightly, decide which behavior is correct, keep one, and give the difference a
  parameter. Do not keep both "because they might diverge".
- Never fork a function to change one line. Never copy a file to start a variant.

## 2. No dead code

- Do not export what no production module imports. Tests import public behavior, not internals; if a
  test needs a private function, test it through the exported entry point instead.
- Exception: a module-level entry point that runs as a process (`src/agents/*/lifecycle-hook.js`,
  `src/cli/*`) may export its pure parsing or formatting functions for tests.
- Delete code when its last caller goes away, in the same change. Do not leave it "for later" or
  comment it out; git history keeps it.
- Do not land a feature module that nothing wires in. Either wire it in the same PR or keep it on the
  branch until it is.
- No unused parameters, unused imports, unused i18n keys, or `_old`/`legacy`/`v2` siblings that outlive
  their migration. A compatibility path needs a comment naming what it is compatible with and when it can go.

## 3. Where shared code lives

Shared helpers belong in a capability-named module, never in `utils`, `helpers` or `common`.
Each row is the single home for that behavior; reuse it or extend it.

| Behavior | Home | Notes |
| --- | --- | --- |
| Canonical JSON for hashing and signing | `packages/roundtable/src/canonical-json.js` | One canonical form for the whole product. Hashes and signatures must not depend on which module computed them. |
| Input value checks (`requiredString`, `requiredResponseString`, `nonEmptyText`, `positiveInteger`, `uniqueTextArray`, `assertJsonObject`) | `src/validation/values.js` | Throw `InvalidInputError` with the caller's label, a constant field name (`test/validation-labels.test.js`). Shared by connectors, MCP argument parsing and HTTP routes. A value FULI binds itself (its personal space, a hook's or MCP process's host session, a task's stored session) uses `requiredBinding`: a plain `TypeError`, so `internal_error`. A value a remote connector returned uses `requiredResponseString`: a `ConnectorResponseError`, so `connector_response_invalid`. |
| A caller's argument FULI cannot use | `src/app/application-error.js` (`InvalidInputError`, code `invalid_input`) | A `TypeError`, so HTTP still answers 400; MCP shows its code and message instead of `internal_error`. The message names the argument and what to pass, never the value. Internal invariants stay plain `TypeError`. |
| Malformed data a remote connector returned | `src/app/application-error.js` (`ConnectorResponseError`, code `connector_response_invalid`) | A `TypeError` like `InvalidInputError`, so connector parsing and HTTP keep working; MCP shows its code so the Agent does not try to fix its own arguments. Read the remote field with `requiredResponseString`; the message names the field, never the value. |
| Deep freeze of config defaults | `src/validation/values.js` | |
| SHA-256 of text, bytes and files | `src/security/digest.js` (`sha256Bytes`, `sha256File`) | One place that decides encoding (`hex`) and streaming for files. |
| Graph Provider readiness wait, managed-workspace detection, process liveness | `src/local-runtime/provider-readiness.js`, `src/local-runtime/processes.js` | Setup, native runtime, adaptive runtime and backup restore all call the same wait with their own timeout and error text. |
| A started child process's log file (Neo4j, Graph Provider, console) | `src/local-runtime/child-process-log.js` (`openChildProcessLog`) | Rotates a log past 50 MB to `.1`–`.3` before the child starts; no spawn opens its log with `openSync(path, 'a')` by hand. |
| Promise-based sleep | `node:timers/promises` (`setTimeout as delay`) | Do not hand-roll `new Promise((resolve) => setTimeout(resolve, ms))`. |
| Atomic text and JSON file writes | `src/storage/json-file.js` (`writeTextFileAtomic`, `writeJsonFileAtomic`) | Keeps the existing file mode; new files are private. `durable` flushes before the replace. A rename Windows refuses while a reader has the file open is retried for a bounded time. No module renames a temporary file into place by hand. |
| A file's exact identity (`dev:ino`) | `src/system/file-identity.js` (`fileIdentity`) | Takes a stat read with `{ bigint: true }` and refuses a Number stat: Windows file IDs exceed 2^53 (rec#49). |
| One-line display text | `src/text/single-line.js` | |
| A UTF-8 byte-bounded text prefix (whole code points plus …) | `src/text/utf8-preview.js` (`utf8Preview`) | Pass `measure` to bound the serialized bytes actually sent. |
| A SQLite store's data format: version, migrations, ledger, backup, version guard | `packages/roundtable/src/storage/database-format.js` (`sqliteFormat`, `openFormattedDatabase`) | A store declares its schema and migrations there and opens its file only through it; no `new DatabaseSync` or DDL anywhere else (rec#17 D-09). |
| FULI JSON data files that must not overwrite a newer FULI's file | `src/storage/json-format.js` (`writeVersionedJsonFileAtomic`) | Client configuration and process state are not FULI data; `test/data-format-inventory.test.js` lists them. |
| A store this version cannot use (newer format, pending or interrupted migration, failed backup) | `packages/roundtable/src/storage/data-format-error.js` | HTTP answers 503 with the reason; MCP shows its code and message. |
| A person's confirmed migration: preview, apply, undo, whole-store restore (rec#17 part 2) | SQLite `packages/roundtable/src/storage/database-migration.js`, JSON `src/storage/json-format-migration.js`, graph `graph-provider/fuli_graph/graph_format_confirm.py` (undo journal `graph_format_journal.py`); one plan and the operations over them in `src/data-format/migration-plan.js`, `migration-operations.js` | Reached from `fuli migrate` and the console's loopback routes only, never from MCP or Agent tools (`test/data-format-console.test.js`). A record-changing graph step declares its `RecordJournal`. |
| Whole-store maintenance of a data directory (a restore excludes a running console and the reverse) | `src/data-format/maintenance-lock.js` | The console holds it shared for its lifetime; `fuli migrate restore` exclusively. |
| Format backup names and lookup, backup retention | `packages/roundtable/src/storage/format-backup-names.js`, `src/data-format/backup-retention.js` | Never prune a backup an undo, the latest ledger entry or the current version needs. |
| The graph provider's environment file (`graph-provider.env`) | `src/setup/provider-env.js` (`parseProviderEnv`) | |
| A property the graph provider stores: its label, type, nullability and enum values | `graph-provider/fuli_graph/graph_field_contract.py`, recorded per graph version in `graph-provider/tests/graph_property_fingerprints.json` | A write that passes a whole map builds it with `stored_record` / `stored_properties`. A new property, type or enum value needs a migration with the next graph version so older guarded builds refuse the graph (rec#30). |
| The graph's constraints, indexes, labels and migrations | `graph-provider/fuli_graph/graph_format_schema.py`, `graph_format_migrations.py` | Only `graph_format.py` runs DDL; a new rule or label is a new migration with the next version. |
| Parsing a model's JSON answer | `src/text/model-json.js` (`parseModelJson`) | Tolerates one Markdown code fence. Judgment and the model port share it. |
| Lifecycle hook stdin reading and size limit | `src/agents/lifecycle-input.js` | Common to every Agent; only the output format stays in `src/agents/<agent>/`. |
| Source applications, and whether a stored client list covers one | `src/agents/source-applications.js` (`SOURCE_APPLICATIONS`, `coversClient`); Python `graph-provider/fuli_graph/client_coverage.py` (`covers_client`) | Every allowed-client and capture-source check goes through it: a list stored with `other` and without `opencode` also covers `opencode` (rec#11 D-64). Schemas take their enum and `maxItems` from the list. |
| CLI line output, terminal confirmation and hidden secret entry | `src/cli/terminal-io.js` | |
| Model API calls of the built-in Agents | `src/model-backends/port.js` | Budget, egress, retry, validation and usage live in the port; protocols only in `src/model-backends/adapters/`. |
| A model request that never follows a redirect | `src/model-backends/no-redirect-fetch.js` (`fetchWithoutRedirect`) | Every model adapter and the Tonborg review evaluation; a redirect is a `refusal` (`endpoint_redirected`). |
| A built-in Agent's work for the current session (no model, or a fallback-eligible failure) | `src/model-backends/role-work.js` (`decide`, `role_work` claim/submit) | Any role calls `decide` instead of the port. An operation the current session started with the evidence in hand passes `inline: true` (no package; the session keeps its usual answer); otherwise it registers a resumer for a work package. Never start a CLI, session or other model. |
| What a role keeps or shows of a model receipt | `src/model-backends/receipt.js` (`compactReceipt`) | |
| Web date and time display | `web/src/lib/date-time.ts` (`formatDateTime`), `web/src/lib/relative-time.ts` | Pass `currentLocale()`; never a hard-coded or browser-default locale. |
| Web identity, debounce | `web/src/lib/identity.ts`, `web/src/lib/debounce.ts` | |
| Web short display ids (unique prefix of a list) | `web/src/lib/short-ids.ts` (`shortUniqueIds`) | Mark a cut with … and keep the full id in a title or copy control. |
| Web motion | `web/src/styles/motion.css` (page transitions, `ui-list` for `TransitionGroup`, disclosures) with the meaning tokens `--motion-enter` / `--motion-exit` / `--motion-move` in `theme/base.css`; `SPRING` in `web/src/lib/motion.ts` for motion-v | No literal durations in motion rules (`styles/motion.spec.ts`). Reduced motion is handled once in `primitives.css`; a component does not add its own override. |
| Web widgets (movable pieces) | `web/src/widgets/registry.ts` (id → component, allowed slots), `web/src/widgets/layout.ts` (slot → widget ids, `resolveLayout`), `WidgetSlot.vue` | A widget owns its data (e.g. `features/team-work/useTeamWork.ts`, one shared read per space) and takes only its slot's context as props; pages and the shell render slots, never a widget directly. |
| Web loading feedback | `web/src/components/GrowthLoading.vue` | See `AGENTS.md`. A pending button uses `Button`'s `loading`. |
| Web buttons | `web/src/components/ui/button` (shadcn-vue `Button`) | Variants `default` (primary), `outline`, `ghost`, `destructive`, `link`; `as-child` for links. Icon-only actions use `UiIconButton`. |
| Web theme tokens and Tailwind preset | `web/src/styles/theme/` | Base → semantic → component tokens; a skin re-points semantic tokens only. |
| Web type scale | `web/src/styles/theme/base.css` (`--text-title` 22, `--text-section` 16, `--text-card-title` 15, `--text-body` 14, `--text-meta` 12; `--weight-regular`/`-medium`/`-strong`) | Utilities `text-xl`/`text-lg`/`text-md`/`text-base`/`text-xs`, `font-normal`/`font-medium`/`font-semibold`. Headings 600, controls 500, no 700. Prose people read takes `.ui-prose` (`--measure`, `--leading-prose`); tables and grids are not capped. |
| Web inline status lines (live updates stopped, a partial read, an action's outcome) | `web/src/ui/UiNotice.vue` (`tone` info / success / warning / error, `#actions` slot) | Not plain text and not a page-local tinted box. |
| Web class merging (`cn`) | `web/src/lib/class-names.ts` | |
| Web modal behavior | `web/src/composables/useModalDialog.ts` | |
| Web shadcn-vue components | `web/src/components/ui/*` (Button, Dialog, Tabs, Card, Accordion, Table, DropdownMenu, Badge; form controls Input, Textarea, Select, Switch, Checkbox, RadioGroup, Label, Field) | Source copies; each `index.ts` records the upstream commit and every local change. Copy only the parts a page uses. Forms compose Field + Label + a control; there is no form framework (no vee-validate). |
| Web page title (the one H1) | `web/src/layouts/page-title.ts` (`usePageTitle`) and route `meta.title` | The shell renders the H1; a page about one record names itself. Pages never render their own `h1`. |
| Web page canvas | route `meta.layout` (`canvas` / `form`), `--canvas-max` / `--form-max` in `web/src/styles/tokens.css` | Collections use 1/2/3/4 columns by canvas width (container queries). |
| Web quick look (Peek) | `web/src/composables/useRoutePeek.ts` with the shadcn-vue `Dialog` | `?item=<space>/<id>`; opening adds history, closing goes Back. Without a router (previews, tests) it is local state. A knowledge item's details (knowledge, preferences, organize) use `web/src/features/knowledge/KnowledgePeek.vue`; on 偏好 and 知识整理 `useKnowledgeItemPeek.ts` puts it in the URL as `?item=<space>/<kind>:<id>` and returns focus to the opener. |
| Web return to a collection | `web/src/composables/useScrollRestoration.ts`, `web/src/composables/useFocusReturn.ts`, `web/src/components/BackLink.vue` | Cards and rows carry `data-return-focus="<id>"`. A record page's "← <collection>" is `BackLink`: it goes Back when that collection opened the page. |
| Task status as a badge tone | `web/src/features/project-agents/task-labels.ts` (`taskStatusTone`) | |
| Roundtable (agent-to-agent asks, chat, wake, LAN peers) | `packages/roundtable/` (`fuli-roundtable`) | Reaches its host only through `src/host.js`; FULI's host is `src/graphiti/roundtable-host.js`. Agent-specific wake adapters live in `packages/roundtable/src/agents/<agent>/`. |
| Identity of names people type (tags; NFKC, line-break and space collapse, lowercase, idempotent) | `graph-provider/fuli_graph/name_identity.py` (`identity_key`, `display_name`); Node stores use the same rule in `src/text/name-identity.js` (`identityKey`, `displayName`) | Never strips punctuation, accents, ZWJ or non-BMP characters. Existing stored keys (`topic_key`, project names) keep their own rule until migrated. |
| A person's tag governance: approve, merge, split, retire, relations, undo (rec#11 D-07 part 2) | `graph-provider/fuli_graph/knowledge_tag_governance.py` (relations in `knowledge_tag_relations.py`, merged-tag redirects in `knowledge_tag_redirects.py`) | Preview by anyone who sees the tag; apply only on the human-review channel with the preview's digest. Every change records each written tag's and link's before/after state for its undo. |
| Boundary tests: which modules an entry reaches | `test-support/module-graph.js` (`reachableModules`) | Proves no MCP or Agent tool entry reaches a console-only port. |
| Python shared values | `provider_values.py` (`json_object`, `sha256_text`), `model_validation.py` (`unique_text_list`), `models.py` (`stored_confirmation_basis`), `auth.py` (`token_hash`) | Do not redefine a private `_helper` that one of these already provides. |

Python follows the same rule: a private `_helper` copied into a second module is a signal to promote it
into a named module both import.

## 4. Function and module shape

- A function does one thing at one level of abstraction. Parse input, then act, then shape output;
  do not interleave the three.
- Validate once at the boundary (MCP tool, HTTP route, CLI option, connector response). Inside the domain,
  trust the validated shape instead of re-checking `typeof` at every layer.
- Prefer plain data in and plain data out. Inject I/O (`fetchImpl`, `wait`, `readText`, clocks) as
  parameters with production defaults, as the existing runtime modules do, so tests need no global mocks.
- Name by what it means in the domain (`taskPreferenceWindow`), not by its type (`data`, `obj`, `result2`).
- Constants that tune behavior (`120` attempts, `256 * 1024` bytes, `2500` ms) get a named constant at the
  top of the module. A magic number that appears in two modules is a shared constant.
- Keep error messages specific to the operation, but keep the mechanism shared. Pass the message in;
  do not copy the loop to change the message.
- Avoid boolean flag parameters that switch behavior; split into two named functions or pass an options
  object with a named field.

### Keep it simple

- Use the least code that solves the requested problem. Do not speculate about future requirements or
  add unrequested features.
- Do not create abstractions for one-off code or add unrequested flexibility or configurability.
- Do not add error handling for impossible scenarios.
- If 200 lines can be written clearly in 50, rewrite them. Ask: would a senior engineer find this
  unnecessarily complex? If so, simplify.

## 5. Vue and TypeScript

- Pages compose; features own behavior. Formatting, filtering and mapping functions go in a `.ts` module
  next to the feature and get a spec, not in a page's `<script setup>`.
- One formatter per display concept (date, time, relative time, project name, source label). A second
  `formatDate` in another page is a duplicate.
- Types for API payloads live in `web/src/types.ts` or the feature's `model.ts`; do not redeclare a payload
  shape inline in a component.

### Let the layout explain itself

- Avoid unnecessary secondary labels and descriptions. Remove copy that repeats what the layout
  already communicates, but keep necessary form labels and control names.
- A redundant visible label may be omitted; the control's accessible name must remain. For example,
  a search field beside a "Search" button still needs an associated label or equivalent accessible
  name; the neighboring button does not name the field.

## 6. Tests

- Test behavior through the public entry point of the module.
- When you merge duplicates, keep the strongest of the existing tests and delete the redundant ones.
- A test that only asserts a private helper exists or returns its input is noise; delete it.

## 7. Before you commit

1. `git diff` and ask, for every new function: does this already exist somewhere?
2. Every new export has a production importer.
3. Every removed caller took its now-unused callee with it.
4. Run the relevant suite (`npm run test:node`, web specs, `graph-provider` tests).
