# FULI Agent workflow recipes

Use these as sequencing hints only. Always call `list_agent_interfaces` and inspect the current tool schema first.

| Intent | Read before | Mutation | Verify after |
| --- | --- | --- | --- |
| Move an external-knowledge connection between projects | `list_external_knowledge_bindings` | `update_external_knowledge_binding_targets` | `check_external_knowledge_binding`, then `retrieve_external_knowledge_binding` or `sync_external_knowledge_binding` when requested |
| Create an external-knowledge connection | `list_external_knowledge_connectors`, `discover_external_knowledge_sources` | `create_external_knowledge_binding` | `check_external_knowledge_binding` |
| Change capture behavior (global, client or project mode; "这个项目以后别记了" is `recordProjects` with the current project's ID) | `get_capture_policy` with `projectPath` | `update_capture_policy` (with the current `taskContextToken`) saves nothing and returns `preview` and `confirmUrl`: show both word for word; the person confirms or cancels in the FULI console. No Agent call can complete it | `get_capture_policy` after the person says they confirmed |
| Pause or resume recording of this session ("这次别记" / "继续记") | none | `update_capture_policy` with only `sessionPaused` and the current `taskContextToken`, at once and without confirmation | end the reply with the returned `agent_receipt` |
| Turn FULI off or on for this session | none | no Agent tool: tell the person to type `/fuli stop` or `fuli stop` (`start`, `restart`, `status`) | the hook's answer is shown to the person |
| Add or change durable knowledge | the narrowest knowledge search/read tool | the matching knowledge submission or decision tool | read the exact item and confirm scope/version |
| Send a kind of work to its own project from now on ("以后 iDev 工时都交给 X") | none | `register_standing_assignment` `preview` writes nothing and returns one `restatement`: ask the user once; after a clear yes, `confirm` with the same input and `confirmationDigest` | the result says registered and assigned, not executed; do the current request, if any, as usual |
| Correct or end such a rule ("工时以后交给 ops" / "iDev 不用再交给 X 了") | none | the same tool with `change` `retire`, `reassign` (`projectName`, `leadAgentId`; default that project's lead) or `edit_terms` (`addTerms`, `removeTerms`), naming the assignment by one of its terms in `term`: `preview`, ask once, `confirm` with the digest. Removing every term is refused; retire instead | the result's `assignment`; the project's own lead is unchanged. The person can also do it in the local console (loopback only) |
| Manage Project Agents | `list_project_agents`, `list_project_agent_tasks`, assignments or recruitment state | the matching Agent/assignment/task/recruitment tool | re-list the same Agent/task and inspect status/events |
| Tag knowledge with an open vocabulary | `resolve_knowledge_tags` in the current project | `change_knowledge_tags`: reuse an exact/alias match, `add_alias` for a synonym, `create` with a reason only when nothing fits (`distinctFrom` only after judging each similar candidate) | `resolve_knowledge_tags` again; `attach` returns the item's visible tags |
| Ask the person to approve, merge, split, retire or undo a tag | `resolve_knowledge_tags` for both tags | `change_knowledge_tags` with that action (`intoTagId` for merge, `name` for split): it only previews and returns `confirmUrl` | give the person the link; nothing changes until they confirm in the console |
| Defer or resolve a preference conflict | `list_preference_conflicts` and both exact knowledge items | `defer_preference_conflict` or `resolve_deferred_preference_conflict` | re-read the conflict and affected items; never claim human confirmation |
| Give one project its own project manager ("给活动项目配个项目经理，列用 待开发/待提测/上线/已完成") | `get_project_team`, `list_project_agents`; Jefa's `read_board` for the current `projectBoard` | a new PM: `upsert_project_agent` with occupation `management`, then `create_project_agent_assignment` with `projectManager.board`; an Agent already assigned there, or a later change ("这个项目改用飞书项目 <link>"): Jefa's `configure_project_board` with `expectedRevision` (keep each column's `id`; each column's `mapsTo` is one built-in status; `kind: "external"` with `external.url` for an outside board) | `read_board` again: `projectBoard.managerAgentId` and `board`. Jefa stays the global lead; its statuses never change |
| Manage a specialist Agent | `list_employee_templates` and the current responsibility scope | recruit or update the specialist scope with its dedicated tool | re-list the template and effective managed projects |
| Publish or remove a public project | read the personal project and current publication | publish/update/delete tool | re-read publication status and release metadata |

For the external-knowledge move example, prefer updating the existing binding targets. Do not delete and recreate the binding merely to change project membership: recreation can lose revision history, connector state, and audit continuity.

Always inspect the complete `targets` array, not the legacy first-target aliases (`target`, `mode`, `sync`). When a user excludes project B, preserve other authorized targets, remove B explicitly, verify the saved array, and synchronize only the requested target/project. An unscoped sync covers every syncable target.

Pass the last-read `targetsVersion` as `expectedTargetsVersion` when changing targets. On `external_knowledge_conflict` or `external_knowledge_busy`, re-read after the other operation completes; do not replay a stale target array. The registry serializes mutations across console/MCP processes; an interrupted process releases its reservation automatically.

Bole is provisioned by the Provider as a fixed native role, not recruited through `recruit_employee`. Inspect staffing through the Project Agent read tools.

Every Agent has a person-like nickname unique in its personal space. When recruiting or creating one, put the job in its occupation and responsibility, not its `displayName`: a job-title name or none is replaced by a generated name, and a taken name gets a number. Changing an existing Agent's `displayName` to a name another Agent uses is refused with `agent_name_taken`. Never rename an existing Agent on your own; a read may return `nameSuggestion` for the person to accept.

The following controls are deliberately local-user-only unless the current interface catalog says otherwise:

- Agent-access policy
- device/runtime settings
- human preference-conflict completion
- preference-scope confirmation
- batch knowledge confirmation
- Jefa work-item completion that records explicit human acceptance
- marking a blocked task as unblocked (「标记为已解除」): suggest the person uses the button on the task card or task detail; an Agent ends a block only by continuing in the session that reported it
- permanently deleting knowledge (「彻底删除」): suggest the person opens the item page's 危险操作 section; there is no Agent tool, not even a preview

Explain the precise UI action when one of these boundaries blocks the request. Never work around it through direct HTTP, storage, browser scripting, or a shell command.
