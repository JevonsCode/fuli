# Connect external knowledge (read-only)

English · [简体中文](external-knowledge.zh-CN.md) · [README](../README.md)

Bind Notion, Lark, MCP, RAG or your own code to projects without giving FULI write access.

## Read-only external knowledge

One knowledge-base connection can be bound to one or more existing personal projects without
granting Fuli write access to the source. Each target keeps independent retrieval mode, sync
cursor, and error state. Settings › Connections supports multi-project assignment, connection
checks, manual synchronization, disconnection, and a per-project conflict switch.

| Connector | Read path | Current boundary |
| --- | --- | --- |
| MCP | Resources `list/read`; configured `search` / `fetch` tools | Default; HTTPS or loopback HTTP, plus stdio |
| Notion | Page Markdown and Data Source queries | Current `2026-03-11` API; explicit page or data-source IDs |
| Feishu / Lark | Wiki nodes, search, and Docx raw content | Docx text only; search may require a user access token |
| RAG Retrieval API | Dify-compatible external-knowledge retrieval contract | Live only; for compatible endpoints or adapters in front of systems such as RAGFlow |
| Trusted custom code | Local ESM `sync` / `retrieve` contract | Explicitly installed trusted code, not a sandbox |

<a id="connect-external-knowledge"></a>

### Connect one or more knowledge bases to a project

One personal project can have multiple knowledge connections, and one connection can target
multiple personal projects. Each submission adds a connection instead of replacing an existing
one. Source configuration is stored once, while retrieval mode, synchronization state, and errors
are isolated per target. Use Bind projects on an existing connection to add or remove targets.

1. Create or confirm the target under Personal projects.
2. If the source needs a token, set it in the environment that starts Fuli, then start or restart
   the service. The binding stores only the environment-variable name. For example, run
   `export PROJECT_KB_TOKEN='...'` and then `fl restart`.
3. Open `http://127.0.0.1:2727/settings?tab=connections` (Settings › Connections). Under External knowledge, enter a connection name,
   connector, one or more bound projects, and retrieval mode.
4. For MCP HTTP, enter the final endpoint URL (redirects to another origin are not followed) and an
   optional token environment-variable name. For MCP stdio,
   enter its command and arguments. For Notion, enter the token environment-variable name and Page
   IDs or Data Source IDs. For Feishu/Lark, enter the token environment-variable name, region, and
   an explicit Space ID, root-node token, or node tokens. For RAG Retrieval API, enter a
   Dify-compatible endpoint, knowledge-base IDs, and an optional token environment-variable name.
   A custom connector takes a trusted local ESM module and source JSON.
5. Select Add connection and then Check. A successful `mirror` or `hybrid` binding can be synced;
   a `live` binding reads its source when an Agent query runs.
6. After creation, use Bind projects to add or remove projects and select a mode per project.

The project graph shows an External knowledge source node and a Uses external knowledge edge for
each assignment. This is a read-only projection of connection configuration. Live bodies are still
retrieved only when an Agent invokes `search_connected_knowledge`; showing the node does not mirror
content locally.

Retrieval modes differ as follows:

- `live`: read the third party at query time without storing a body mirror in Fuli; the source must
  be available.
- `mirror`: manually mirror read-only content into the bound personal project and query the graph.
- `hybrid`: use both the local mirror and live source results; recommended when the connector
  supports both capabilities.

Bindings support `live`, `mirror`, and `hybrid` modes. Mirror content is written only to the bound
personal project as `observed`, `pending`, `restricted`, local-only knowledge. Credentials are read
from named environment variables and are not stored in binding JSON. Source writes are never part
of the connector contract. Documents that look like credential material are skipped individually,
reported by count, and never enter the graph or Agent context.

<a id="external-knowledge-conflict-policy"></a>

### Conflict policy

One default applies to every personal project; a project can keep its own choice as an exception
(Connections → Conflict policy). The policy covers that project's personal graph, all external
bindings, and explicitly selected public projects:

- Ask in the Agent conversation is the built-in default. The Agent presents conflicting content,
  source, and scope separately so the user can choose.
- Allow an Agent decision lets the Agent select the stronger or fresher source for the current
  response and requires it to explain the basis. It never confirms, invalidates, overwrites, or
  writes back any knowledge.

From the project directory, an Agent can be asked: `Search the current project and connected knowledge bases for the payment callback contract; list conflicting sources and ask me to decide.`

`search_connected_knowledge` keeps personal-graph evidence, each external binding, and explicitly
selected public projects as separate source sets. Public-project aggregation is **Beta**. When an
Agent finds a material conflict, the default policy is to show it in the conversation and ask the
user; the optional Agent-decision policy applies to the current response only and cannot confirm,
invalidate, or rewrite any source. Scheduled sync, webhooks, and full deletion reconciliation remain **TODO**.

See the [external-knowledge architecture and connector contract](external-knowledge-architecture.md).
