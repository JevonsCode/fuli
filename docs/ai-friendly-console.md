# AI-friendly console

Every console action should be doable by the person's own AI, with as little of the person's effort as the trust model allows (Jevons, 11-06). Three paths reach the same capability layer: the interface catalog (`src/agent-tools/interface-catalog.js`) and the console's own routes.

| Who acts | Path | What decides |
| --- | --- | --- |
| An Agent with FULI's MCP connected (Claude Code, Codex, OpenCode…) | Named Agent tools; `run_delegated_action` for catalog routes | The catalog entry, the person's AI permissions, their words for `agent_relayed` |
| The AI in the person's browser (WebMCP) | Console page tools (`fuli_*`) | The same delegation gate; the person's click on the page where the gate says the change is theirs |
| The person | The console | — |

## Console page tools (WebMCP)

[WebMCP](https://webmachinelearning.github.io/webmcp/) lets a page offer tools to the browser's AI agent. Chrome's origin trial (149+) puts it on `document.modelContext`; older builds used `navigator.modelContext`. FULI feature-detects both (`web/src/features/webmcp/model-context.ts`), registers with `registerTool(tool, { signal })` and unregisters by aborting the signal when the page goes; an older build's `unregister()` handle is called too. Read tools carry `readOnlyHint`, changes `consequentialHint`. Where the browser offers no model context, nothing is registered.

| Page | Tools |
| --- | --- |
| Every page | `fuli_open_page`, `fuli_search_knowledge` |
| 模型与用量 | `fuli_read_model_settings`, `fuli_configure_model_role`, `fuli_save_model_key`, `fuli_list_endpoint_models`, `fuli_test_model_role` |
| 设置 | `fuli_read_settings`, `fuli_update_settings` (settings that apply without a restart) |
| 待决策 | `fuli_list_decisions`, `fuli_decide` |

### One source of truth

A page tool declares the catalog routes it reaches (`routes`); it cannot send a change to an undeclared route, and `test/ai-friendly-console.test.js` fails when a declared change route has no catalog entry. Tools build their bodies with the page's own builders (`roleDraft`, `roleEdit`, `withoutRestartChanges`), not a copy.

### Trust model

A page tool runs in the person's own page, so a change it sends would otherwise be recorded as the person's. It is therefore sent first exactly as `run_delegated_action` sends it, with the `x-fuli-delegation` header (actor client `webmcp`, the agent's reason). The console's delegation gate then decides from the catalog and the person's AI permissions, and records the change with its undo in 设置 › AI 权限 (shown as 浏览器 AI). A page tool never does more without the person than an FLA could.

When the gate answers that the change is the person's own (`local_user_only`, `agent_relayed` without words, a category they turned off, or a route that has its own Agent tool), the page asks the person in a confirm sheet (`PersonConfirmSheet.vue`). Only their click sends the change as their own request. Closing the sheet or aborting the call counts as no. Agent access turned off (`agent_access_disabled`) refuses outright. WebMCP defines no consent API of its own (its `consequentialHint` lets the browser add one), so FULI's sheet is the consent.

- **A model key** (`fuli_save_model_key`) is always the person's: the sheet names the key reference and shows only its last four characters. The key goes once, in a loopback request body, into the existing local key store; it is never logged, echoed or returned.
- **Listing an endpoint's models** sends the saved key to a typed address, so the sheet names that host.
- **待决策 decisions** (`fuli_decide`) are recorded as the person's (人确认): the agent proposes a batch, and one click allows the whole batch.

The sheet guards against an agent's mistakes and injected instructions. It is not a boundary against something that already drives the person's browser, which could click the sheet too, as it could any console button.

## 「?」 and 「让 AI 来做」

Every settings card and the main pages (模型与用量, 待决策, FLAs, 知识, 连接) have a 「?」 (`AiHelpButton.vue`). It opens the glossary's explanation card for that area (the same layer as Alt-click glossary mode). Where the person's Agent can do the job, the card offers 「让 AI 来做」: a prompt to copy, filled with this console's address (`features/ai-help/ai-task-prompts.ts`). Where only the person can act (AI permissions, Agent access, Tonborg's autonomy, data format, diagnostics, language and motion), the card says why and offers no prompt.

The prompts address the person's Agent, not the person, so they are kept out of the console's messages, whose rule is that the person is never sent to a terminal. `test/ai-friendly-console.test.js` checks every prompt in both languages: each quoted route must be a `run_delegated_action` route in the catalog, each read route must exist, and each snake_case word must be a FULI tool.

The model prompt is the main case: find an endpoint and key the person can use, list its models with that key, pipe the key on stdin into `fuli models set-key` (or ask the person to paste it), save the role with `run_delegated_action`, test it, and approve only the projects the person named for egress.

## Coverage audit (2026-11-06)

The catalog lists 167 console mutations: 67 named Agent tools, 52 `agent_delegable`, 8 `agent_delegable_off`, 13 `agent_relayed` and 27 `local_user_only`. `test/agent-interface-parity.test.js` keeps every web mutation in the catalog. Browser-only preferences (language, reduced motion) are not FULI data and have no Agent path.

Changed here:

- `POST /api/model-backends/roles/:role/check` (测试连接) moved from `local_user_only` to `agent_delegable` (model_settings). It sends one fixed request with no project content to the endpoint the role already uses, which the role's own work reaches anyway. The role edit that chooses that endpoint was already delegable.
- Model key entry stays `local_user_only` for every Agent tool. It gains two sanctioned paths: the person's Agent pipes the key into `fuli models set-key` on stdin when the person asked, or the browser AI fills it through the page tool after the person's click.
- Listing an endpoint's models stays `local_user_only`: the Agent that found the key lists the models itself, and the page tool asks the person first.

Deliberately the person's (unchanged): their own roundtable messages; Agent access and AI permissions; Tonborg's autonomy policy; data format apply, rollback, prune and restore; the graph migration (it restarts FULI); permanent knowledge deletion with its preview, export and status; deleting old data now; deleting an Agent app's code or data, and the typed app confirmation; the hidden debug capture.

Proposed follow-ups, not in this change:

- `POST /api/retrieval-terms/trial|fill|stop` and `POST /api/dreaming/run` send project content to the person's model. The projects are already approved for that model through a delegable role edit, so these could become `model_settings` delegable; the cost is the remaining question.
- Bind a saved key to the endpoint host it was saved for. Today a delegable role edit could point a connection that names an existing key at another host, and the role's next call would send that key there.
