---
name: operating-fuli
description: Use when an AI Agent needs to inspect or change FULI knowledge, personal projects, Project Agents, specialist Agents, public-project subscriptions, reviews, capture policy, or external-knowledge connections through structured tools instead of browser automation. Also use to check whether a FULI UI action has an Agent interface and to explain a deliberate local-user-only boundary.
---

# Operating FULI

Operate FULI through its structured Agent interfaces. Treat the UI and Agent tools as two clients of the same application services; never use browser clicks as a data mutation fallback.

## Required workflow

1. Establish the exact scope from the current task. Resolve real `personalSpaceId`, `personalProjectId`, item IDs, and versions through read tools. Never guess an identifier or infer one from a display name.
2. Call `list_agent_interfaces` before the first mutation. Use its catalog to determine whether the UI capability is `agent` accessible or intentionally `local_user_only`.
3. Inspect the exact input schema for the selected tool. Prefer one domain-specific tool over generic HTTP, shell, database, or browser access.
4. Read the current record immediately before changing it. Preserve fields the user did not ask to change.
5. Check the safety boundary below. Stop if the action needs missing user authority or is marked `local_user_only`.
6. Execute the smallest scoped mutation. Supply `expectedRevision`, `expectedUpdatedAt`, `idempotencyKey`, or request IDs whenever the tool supports them.
7. Re-read through the corresponding structured read tool. Report the actual resulting scope, version, status, and any partial failure.

If an expected capability is absent from `list_agent_interfaces`, report an Agent-interface parity gap. Do not hide the gap by opening Chrome, clicking the UI, writing storage directly, or searching outside the current repository.

## Safety boundary

- Never enable or weaken Agent access through an Agent tool. The Agent-access kill switch remains a local-user control.
- Never change device/runtime settings or complete human confirmation queues on the user's behalf when the catalog marks them `local_user_only`.
- Never mark a Jefa work item complete through its human-acceptance workbench route; use an Agent task-update tool only for non-acceptance workflow changes.
- Require explicit user authorization for deletes, publication, subscription changes, destructive conflict decisions, or changes that affect another project. An unambiguous request already authorizes that exact action; do not ask again unless the target or consequences remain unclear.
- Use environment-variable references for connector secrets. Never request, print, store, or copy secret values into knowledge records, logs, Skill files, or tool arguments that expect only a reference.
- Stay inside the exact FULI workspace and registered project scopes. Do not use home-directory-wide discovery as a fallback.
- Browser automation may be used only for optional visual verification after a structured operation. It must not be the mechanism that changes FULI data.

## Selecting tools

Start from `list_agent_interfaces`; names and schemas can evolve. Common workflows and verification pairs are summarized in [workflow-recipes.md](references/workflow-recipes.md). Load that reference only when choosing or sequencing tools is not obvious from the catalog.

For read-only questions, use the narrowest list/get/search tool and return source and scope information. For writes, keep the user-requested scope explicit and verify after mutation. For multi-step operations, stop on the first failed invariant rather than continuing with a partially stale plan.

## Handling conflicts and failures

- On revision or timestamp conflict, re-read, explain what changed, and recompute the intended patch. Do not blindly retry stale input.
- On permission or `local_user_only` errors, identify the exact local UI action required. Do not bypass the boundary.
- On partial external sync, preserve the binding, report per-target/source failures, and let the user choose whether to retry.
- On an unknown tool or missing parity mapping, record the missing capability as a product defect instead of substituting browser automation.

## Completion response

State what changed, the exact project or item scope, the verification result, and any remaining human-only action. Do not claim success from a configured capability or submitted request alone.
