# Built-in Skills and prompt surfaces

Fuli distributes one personal-runtime npm package, `fuli-context`. Skills are
instruction packages, not separate paid product editions.

## Installed Skills

| Skill | Purpose | Source |
| --- | --- | --- |
| `capturing-session-knowledge` | Recall scoped knowledge, apply collaboration preferences, and capture durable task outcomes with provenance. | [SKILL.md](../skills/capturing-session-knowledge/SKILL.md) |
| `operating-fuli` | Operate projects, knowledge, Agents, recruitment, workbenches, and review through structured Fuli tools. | [SKILL.md](../skills/operating-fuli/SKILL.md) |
| `grilling-project` | Establish or clarify a project profile from requirements and evidence, including publication boundaries. | [SKILL.md](../skills/grilling-project/SKILL.md) |
| `flreview` | Run the explicitly requested personal knowledge review workflow. | [SKILL.md](../skills/flreview/SKILL.md) |

`user-taste` is a dynamic read-time projection of applicable preferences and
confirmed taste/personality signals. It is not a fifth bundled `SKILL.md` and does
not replace a user's own Skill. See [user-taste-skill.js](../src/graphiti/user-taste-skill.js).

## Prompt surfaces

Fuli's guidance is generated at these boundaries rather than kept in one flat
prompt list. Tool schemas also describe each operation's scope and constraints.

| Surface | Guidance | Source |
| --- | --- | --- |
| Client bootstrap and lifecycle hooks | Task entry, exact project/session scope, preferences, and task checkpointing. | [bootstrap](../src/setup/codex-bootstrap.js), [client adapters](../src/agents/) |
| MCP server and tool contracts | Required entry/receipt behavior, authorization boundaries, and operation-specific inputs. | [instructions](../src/mcp/instructions.js), [tool definitions](../src/agent-tools/) |
| Task knowledge workflow | Retrieval, durable capture, human attention, and checkpoint decisions. | [workflows](../src/graphiti/agent-knowledge-workflows.js) |
| Collaboration preferences | Applicable scope, confirmation authority, inheritance, and unresolved conflicts. | [preference workflow](../src/graphiti/collaboration-preference-workflow.js) |
| Agent and team context | Responsibility, configured character, private memory, reporting lead, and scoped worker instructions. | [task entry](../src/graphiti/project-agent-task-entry.js), [team context](../src/graphiti/project-agent-team-context.js), [Agent workflows](../src/graphiti/project-agent-workflows.js) |
| Roundtable delivery | Recipient, sender, question, reply instructions, and thread continuation. Session authorization uses Provider capabilities, not prompt text. | [roundtable](../src/agent-roundtable/service.js) |
| Identity receipt | Truthful task owner, collaborators, profile links, and continuation hints. | [identity receipt](../src/agents/identity-receipt.js) |
| Built-in employee roles | Jefa's project board/concurrency/review rules and Bole's evidence-based recruitment rules. | [employee catalog](../src/employees/catalog/), [employee task entry](../src/employees/task-entry.js) |

Personal Agent names, assignments, memories, project facts, and preferences are
local user data. They are not hardcoded in these shared instructions. Independently
configured prompt managers or third-party Skills remain separate from Fuli's
bundled catalog.
