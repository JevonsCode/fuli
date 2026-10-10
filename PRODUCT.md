# Fuli

Fuli is a local-first collaboration relationship graph for people working with AI agents.
Its personal edition connects project context, durable agent identity, working memory,
confirmed preferences and evidence across supported clients such as Codex, Claude Code
and Cursor. A client adapter determines which visible conversation content can be captured.

## People and outcomes

The public website addresses developers and small project teams who repeatedly explain
the same project to different agents. It should make continuity, collaboration and growing
shared understanding tangible, then lead to the repository and personal-edition setup.
The first public website is primarily Chinese.

## Product truth

- Agents have durable profiles, project responsibilities, working history and expectations.
- HR helps find and staff agents; project management tracks work and review. Actual execution
  still requires an available, authorized client and executor.
- Private conversation history is distinct from confirmed reusable knowledge. Once a
  conversation passes a size threshold, older messages fold into a compact digest while recent
  messages stay verbatim; nothing is forgotten because of elapsed time. Retrieval is bounded and additional evidence is loaded on demand.
- Taste, personality and judgment preferences have explicit sources and scopes. Inferred
  preferences require confirmation; people retain authority over what becomes trusted.
- The personal edition runs locally. A separate team server package is not yet released.
- Cross-client continuity requires Fuli integration, the same reachable data and correct
  project/agent identity. It is not a promise of native mention menus or complete transcripts
  from every client.

## Interaction principles

- Keep every human interaction simple, easy to understand and short. Prefer a useful
  default and one obvious next action; reveal advanced choices only when needed.
- Let people delegate routine decisions within their chosen scope. Ask only for missing
  information or authority that changes the outcome, and do not repeat settled questions.
- Keep decision reasons and outcomes inspectable. Feedback should take one click, with
  an optional reason; do not require a form to express agreement or disagreement.
- Use familiar icons for simple actions such as closing navigation and pinning, with
  accessible names and tooltips. Keep text where an icon alone would be ambiguous.
- Preserve explicit authorization and honest execution states. Fewer steps must not hide
  consequences, fabricate confirmation or present a recommendation as completed work.

## Website

An expressive, diagram-led scrolling explanation with clear short copy. Motion illustrates
how context connects and persists; it must respect reduced-motion preferences. Keep all
essential information accessible without JavaScript. Demonstration people and tasks are
explicitly fictional. Publish only public product facts, never private project data.

Use familiar icons for self-evident actions, with accessible names. The hero uses one
centered down arrow, not multiple scroll instructions. Remove copy that merely describes
the interface or repeats the adjacent diagram; keep meaningful product explanations.

Success means visitors understand the mechanism and can start with the documented local
setup, not that they spend longer watching effects.

## Brand assets

Fuli already has an established logo. Use the original artwork at
`site/assets/fuli-logo.png`, identical to `web/assets/brand/fuli-logo.png`.
Website redesigns preserve this logo, its colors and proportions. Do not redraw it,
replace it with an initial, recolor it, or create a new brand mark without an explicit request.

## Local console

The console under `web/` has its own product brief; see [console-product.md](docs/console-product.md).
