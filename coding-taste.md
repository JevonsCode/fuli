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
| Input value checks (`requiredString`, `nonEmptyText`, `positiveInteger`, `uniqueTextArray`, `assertJsonObject`) | `src/validation/values.js` | Throw `TypeError` with the caller's label. Shared by connectors, MCP argument parsing and HTTP routes. |
| Deep freeze of config defaults | `src/validation/values.js` | |
| SHA-256 of text, bytes and files | `src/security/digest.js` (create on first move) | One place that decides encoding (`hex`) and streaming for files. |
| Graph Provider readiness wait, managed-workspace detection, process liveness | `src/local-runtime/provider-readiness.js`, `src/local-runtime/processes.js` | Setup, native runtime, adaptive runtime and backup restore all call the same wait with their own timeout and error text. |
| Promise-based sleep | `node:timers/promises` (`setTimeout as delay`) | Do not hand-roll `new Promise((resolve) => setTimeout(resolve, ms))`. |
| Atomic text and JSON file writes | `src/storage/json-file.js` (`writeTextFileAtomic`, `writeJsonFileAtomic`) | Keeps the existing file mode; new files are private. |
| One-line display text | `src/text/single-line.js` | |
| Parsing a model's JSON answer | `src/text/model-json.js` (`parseModelJson`) | Tolerates one Markdown code fence. Judgment and the model port share it. |
| Lifecycle hook stdin reading and size limit | `src/agents/lifecycle-input.js` | Common to every Agent; only the output format stays in `src/agents/<agent>/`. |
| CLI line output, terminal confirmation and hidden secret entry | `src/cli/terminal-io.js` | |
| Model API calls of the built-in Agents | `src/model-backends/port.js` | Budget, egress, retry, validation and usage live in the port; protocols only in `src/model-backends/adapters/`. |
| Web date and time display | `web/src/lib/date-time.ts` (`formatDateTime`), `web/src/lib/relative-time.ts` | Pass `currentLocale()`; never a hard-coded or browser-default locale. |
| Web identity, debounce | `web/src/lib/identity.ts`, `web/src/lib/debounce.ts` | |
| Web short display ids (unique prefix of a list) | `web/src/lib/short-ids.ts` (`shortUniqueIds`) | Mark a cut with … and keep the full id in a title or copy control. |
| Web loading feedback | `web/src/components/GrowthLoading.vue` | See `AGENTS.md`. A pending button uses `Button`'s `loading`. |
| Web buttons | `web/src/components/ui/button` (shadcn-vue `Button`) | Variants `default` (primary), `outline`, `ghost`, `destructive`, `link`; `as-child` for links. Icon-only actions use `UiIconButton`. |
| Web theme tokens and Tailwind preset | `web/src/styles/theme/` | Base → semantic → component tokens; a skin re-points semantic tokens only. |
| Web class merging (`cn`) | `web/src/lib/class-names.ts` | |
| Web modal behavior | `web/src/composables/useModalDialog.ts` | |
| Web shadcn-vue components | `web/src/components/ui/*` (Button, Dialog, Tabs, Card, Accordion, Table, DropdownMenu, Badge; form controls Input, Textarea, Select, Switch, Checkbox, RadioGroup, Label, Field) | Source copies; each `index.ts` records the upstream commit and every local change. Copy only the parts a page uses. Forms compose Field + Label + a control; there is no form framework (no vee-validate). |
| Web page title (the one H1) | `web/src/layouts/page-title.ts` (`usePageTitle`) and route `meta.title` | The shell renders the H1; a page about one record names itself. Pages never render their own `h1`. |
| Web page canvas | route `meta.layout` (`canvas` / `form`), `--canvas-max` / `--form-max` in `web/src/styles/tokens.css` | Collections use 1/2/3/4 columns by canvas width (container queries). |
| Web quick look (Peek) | `web/src/composables/useRoutePeek.ts` with the shadcn-vue `Dialog` | `?item=<space>/<id>`; opening adds history, closing goes Back. Without a router (previews, tests) it is local state. A knowledge item's details (knowledge, preferences, organize) use `web/src/features/knowledge/KnowledgePeek.vue`; on 偏好 and 知识整理 `useKnowledgeItemPeek.ts` puts it in the URL as `?item=<space>/<kind>:<id>` and returns focus to the opener. |
| Web return to a collection | `web/src/composables/useScrollRestoration.ts`, `web/src/composables/useFocusReturn.ts`, `web/src/components/BackLink.vue` | Cards and rows carry `data-return-focus="<id>"`. A record page's "← <collection>" is `BackLink`: it goes Back when that collection opened the page. |
| Task status as a badge tone | `web/src/features/project-agents/task-labels.ts` (`taskStatusTone`) | |
| Roundtable (agent-to-agent asks, chat, wake, LAN peers) | `packages/roundtable/` (`fuli-roundtable`) | Reaches its host only through `src/host.js`; FULI's host is `src/graphiti/roundtable-host.js`. Agent-specific wake adapters live in `packages/roundtable/src/agents/<agent>/`. |
| Identity of names people type (tags; NFKC, line-break and space collapse, lowercase, idempotent) | `graph-provider/fuli_graph/name_identity.py` (`identity_key`, `display_name`) | Never strips punctuation, accents, ZWJ or non-BMP characters. Existing stored keys (`topic_key`, project names) keep their own rule until migrated. |
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

## 5. Vue and TypeScript

- Pages compose; features own behavior. Formatting, filtering and mapping functions go in a `.ts` module
  next to the feature and get a spec, not in a page's `<script setup>`.
- One formatter per display concept (date, time, relative time, project name, source label). A second
  `formatDate` in another page is a duplicate.
- Types for API payloads live in `web/src/types.ts` or the feature's `model.ts`; do not redeclare a payload
  shape inline in a component.

## 6. Tests

- Test behavior through the public entry point of the module.
- When you merge duplicates, keep the strongest of the existing tests and delete the redundant ones.
- A test that only asserts a private helper exists or returns its input is noise; delete it.

## 7. Before you commit

1. `git diff` and ask, for every new function: does this already exist somewhere?
2. Every new export has a production importer.
3. Every removed caller took its now-unused callee with it.
4. Run the relevant suite (`npm run test:node`, web specs, `graph-provider` tests).
