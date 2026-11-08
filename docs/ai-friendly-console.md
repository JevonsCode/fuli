# AI-friendly console

Every console action should be doable by the person's own AI, with as little of the person's effort as the trust model allows (Jevons, 11-06). Three kinds of caller reach the same capability layer: the interface catalog (`src/agent-tools/interface-catalog.js`) and the console's own routes.

| Who acts | Path | What decides |
| --- | --- | --- |
| An Agent with FULI's MCP connected (Claude Code, Codex, OpenCode…) | Named Agent tools; `run_delegated_action` for catalog routes | The catalog entry, the person's AI permissions, their words for `agent_relayed` |
| The AI in the person's browser (WebMCP) | Console page tools (`fuli_*`) | The same delegation gate, and nothing else |
| The person | The console | — |

## Console page tools (WebMCP)

[WebMCP](https://webmachinelearning.github.io/webmcp/) lets a page offer tools to the browser's AI agent. Chrome's origin trial (149+) puts it on `document.modelContext`; older builds used `navigator.modelContext`. FULI feature-detects both (`web/src/features/webmcp/model-context.ts`). It registers each tool with `registerTool(tool, { signal })` and unregisters it by aborting the signal when the page goes; an older build's `unregister()` handle is called too. Read tools carry `readOnlyHint` and changes carry `consequentialHint`. Tools whose answer holds text other Agents or sources wrote (knowledge search, the 待决策 lines) also carry `untrustedContentHint`. Where the browser offers no model context, nothing is registered.

| Page | Tools |
| --- | --- |
| Every page | `fuli_open_page`, `fuli_search_knowledge` |
| 模型与用量 | `fuli_read_model_settings`, `fuli_configure_model_role` (connection, model, key name, on/off, operations; never which projects may send content), `fuli_test_model_role` |
| 设置 | `fuli_read_settings`, `fuli_update_settings` (settings that apply without a restart) |
| 待决策 | `fuli_list_decisions` (read only) |

### One source of truth

A page tool declares the catalog routes it reaches (`routes`) and cannot send a change anywhere else. Tools build their bodies with the page's own builders (`roleDraft`, `roleEdit`, `withoutRestartChanges`), not a copy. `test/ai-friendly-console.test.js` fails in two cases: a declared change route has no catalog entry, or a page tool reaches a route the catalog does not make `agent_delegable`.

### Trust model (dot review of fuli PR 784)

A page tool's change is sent only the way `run_delegated_action` sends it, with the `x-fuli-delegation` header (actor client `webmcp`, the agent's reason). The console's delegation gate decides from the catalog and the person's AI permissions, and records the change with its undo in 设置 › AI 权限 (shown as 浏览器 AI). A page tool never does more than an FLA could.

When the gate answers that a change is the person's own, the tool is refused with the gate's reason and nothing is sent again. That covers `local_user_only`, `agent_relayed` without words, a category the person turned off, and a route that has its own Agent tool. The agent then tells the person where to click. Agent access turned off (`agent_access_disabled`) refuses too.

There is no in-page "allow" sheet. Anything that drives the page could click it, so it would not show that the person approved. Nothing in the page can tell the person's click from the agent's, so these actions stay refused instead of being downgraded to the person's own request. For the same reason there is no page tool for the following:

- **A model key.** The person enters it in the model dialog. Or their MCP Agent, when asked, pipes it into `fuli models set-key <secretRef> --endpoint <url>` on stdin.
- **Listing an endpoint's models.** This sends a saved key to a typed address. The Agent that found the key lists the models itself.
- **Which projects' content may go to a model (egress).** Text an agent read elsewhere could otherwise point project content at an address it chose. The person sets egress in the model dialog, or an MCP Agent sets it through `run_delegated_action`, where it is recorded with its undo.
- **Confirming or dropping 待决策 items.** These are recorded as the person's decision. The agent reads the list and suggests, and the person clicks. An MCP Agent can instead relay the person's exact words through `agent_relayed`.

### Keys are tied to their endpoint (dot review of fuli PR 784)

Each saved key records the endpoint origin it was saved for: scheme, host and port (`src/model-backends/secret-store.js`). The store reads a key only for a request to that origin, so a connection pointed at another host never receives it:

- **Saving.** The model dialog sends the endpoint typed above the key field; the CLI requires `--endpoint`.
- **Sending.** The model port refuses a call before decrypting the key, with receipt reason `key_endpoint_mismatch`. That covers role calls and 测试连接. The endpoint listing answers `409 secret_endpoint_mismatch` before any request leaves.
- **Editing.** A role edit (delegated, or the person's own) that points a connection naming a tied key at another origin is refused with `409 key_endpoint_mismatch` and leaves the file unchanged. Using the key elsewhere means saving it again for the new endpoint. The dialog says so when the typed address differs from the key's origin.
- **Older keys.** Keys saved before origins were recorded are tied once, when a runtime first opens the store. Each goes to the single origin of the configured connections that name it. A key that none or several connections name stays untied, and is refused (`secret_endpoint_unbound`) until it is saved again. A role edit may keep an untied key on the origin its connection already had, but cannot give it to a new connection or a new origin. Otherwise the one-time binding could tie it to an address an Agent chose.

## 「?」 and 「让 AI 来做」

Every settings card and the main pages (模型与用量, 待决策, FLAs, 知识, 连接) have a 「?」 (`AiHelpButton.vue`). It opens the glossary's explanation card for that area, the same layer as Alt-click glossary mode. Where the person's Agent can do the job, the card offers 「让 AI 来做」: a prompt to copy, filled with this console's address (`features/ai-help/ai-task-prompts.ts`). Some actions only the person can take: AI permissions, Agent access, Tonborg's autonomy, data format, diagnostics, language and motion. Their cards say why and offer no prompt.

The prompts address the person's Agent, not the person, so they are kept out of the console's messages, whose rule is that the person is never sent to a terminal. `test/ai-friendly-console.test.js` checks every prompt in both languages:

- each quoted route must be a `run_delegated_action` route in the catalog
- each read route must exist
- each snake_case word must be a FULI tool

The model prompt is the main case:

1. Ask the person which endpoint and key to use, or use the one they named. Never search for a key yourself.
2. List the endpoint's models with that key.
3. Pipe the key into `fuli models set-key … --endpoint …`, or ask the person to paste it.
4. Save the role with `run_delegated_action`.
5. Test it.
6. Approve egress only for the projects the person named.

## Coverage audit (2026-11-06)

The catalog lists 167 console mutations:

| Access | Count |
| --- | --- |
| Named Agent tools | 67 |
| `agent_delegable` | 52 |
| `agent_delegable_off` | 8 |
| `agent_relayed` | 13 |
| `local_user_only` | 29 |

`test/agent-interface-parity.test.js` keeps every web mutation in the catalog. Browser-only preferences (language, reduced motion) are not FULI data and have no Agent path.

Changed here:

- `POST /api/model-backends/roles/:role/check` (测试连接) moved from `local_user_only` to `agent_delegable` (model_settings). It sends one fixed request with no project content to the role's configured endpoint. Since keys are now tied to their origin, that endpoint can only receive the key it was saved for.
- Model key entry stays `local_user_only` for every Agent tool and has no page tool. The sanctioned paths are the model dialog, or the Agent the person asked piping the key into `fuli models set-key --endpoint` on stdin. That Agent already holds the key, so the CLI gives it nothing new; the binding stops anyone from moving a key they do not hold.
- Listing an endpoint's models stays `local_user_only`.

Deliberately the person's (unchanged):

- their own roundtable messages
- Agent access and AI permissions
- Tonborg's autonomy policy
- data format apply, rollback, prune and restore
- the graph migration (it restarts FULI)
- permanent knowledge deletion, with its preview, export and status
- deleting old data now
- deleting an Agent app's code or data, and the typed app confirmation
- the hidden debug capture

Proposed follow-up, not in this change: `POST /api/retrieval-terms/trial|fill|stop` and `POST /api/dreaming/run` send project content to the person's model. The projects are already approved for that model through a delegable role edit, so these could become `model_settings` delegable; the cost is the remaining question.
