# FULI Agent workflow recipes

Use these as sequencing hints only. Always call `list_agent_interfaces` and inspect the current tool schema first.

| Intent | Read before | Mutation | Verify after |
| --- | --- | --- | --- |
| Move an external-knowledge connection between projects | `list_external_knowledge_bindings` | `update_external_knowledge_binding_targets` | `check_external_knowledge_binding`, then `retrieve_external_knowledge_binding` or `sync_external_knowledge_binding` when requested |
| Create an external-knowledge connection | `list_external_knowledge_connectors`, `discover_external_knowledge_sources` | `create_external_knowledge_binding` | `check_external_knowledge_binding` |
| Change capture behavior | `get_capture_policy` | `update_capture_policy` | `get_capture_policy` |
| Add or change durable knowledge | the narrowest knowledge search/read tool | the matching knowledge submission or decision tool | read the exact item and confirm scope/version |
| Manage Project Agents | `list_project_agents`, `list_project_agent_tasks`, assignments or recruitment state | the matching Agent/assignment/task/recruitment tool | re-list the same Agent/task and inspect status/events |
| Defer or resolve a preference conflict | `list_preference_conflicts` and both exact knowledge items | `defer_preference_conflict` or `resolve_deferred_preference_conflict` | re-read the conflict and affected items; never claim human confirmation |
| Manage a specialist Agent | `list_employee_templates` and the current responsibility scope | recruit or update the specialist scope with its dedicated tool | re-list the template and effective managed projects |
| Publish or remove a public project | read the personal project and current publication | publish/update/delete tool | re-read publication status and release metadata |

For the external-knowledge move example, prefer updating the existing binding targets. Do not delete and recreate the binding merely to change project membership: recreation can lose revision history, connector state, and audit continuity.

Always inspect the complete `targets` array, not the legacy first-target aliases (`target`, `mode`, `sync`). When a user excludes project B, preserve other authorized targets, remove B explicitly, verify the saved array, and synchronize only the requested target/project. An unscoped sync covers every syncable target.

Pass the last-read `targetsVersion` as `expectedTargetsVersion` when changing targets. On `external_knowledge_conflict` or `external_knowledge_busy`, re-read after the other operation completes; do not replay a stale target array. The registry serializes mutations across console/MCP processes; an interrupted process releases its reservation automatically.

Bole is provisioned by the Provider as a fixed native role, not recruited through `recruit_employee`. Inspect staffing through the Project Agent read tools.

The following controls are deliberately local-user-only unless the current interface catalog says otherwise:

- Agent-access policy
- device/runtime settings
- human preference-conflict completion
- preference-scope confirmation
- batch knowledge confirmation
- Jefa work-item completion that records explicit human acceptance

Explain the precise UI action when one of these boundaries blocks the request. Never work around it through direct HTTP, storage, browser scripting, or a shell command.
