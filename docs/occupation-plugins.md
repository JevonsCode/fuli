# Occupation plugins (起步包)

Each FLA occupation can have a starter kit: how good practitioners of that job check their work,
which Agent Skills help, and which MCP servers are worth connecting. FULI does not write this
text. Every kit is curated from a well-maintained, permissively licensed open-source collection,
quoted at a pinned commit with its license, and delivered as a plugin.

## Where it lives

- `registry/occupation-plugins.json` ships with FULI. FULI also reads the public copy on `main`
  (`https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/occupation-plugins.json`) once a
  day and applies a newer, valid copy without a FULI release (the person can turn daily updates off,
  or check and apply by hand; `POST /api/occupation-plugins/check`, `/apply`, `PUT /auto-update`).
  This is the same mechanism as the client link manifest (`src/registry/updatable-manifest.js`):
  a copy is accepted only whole, only when every field passes the parser, and only by the digest of
  what the last check showed. A FULI upgrade with a newer bundled copy wins again.
- `occupation-plugins.json` in the data directory keeps the applied copy, the auto-update switch and
  the last 20 updates. `occupation-kit-choices.sqlite` keeps the person's answers per FLA, append-only.

## Manifest format (`formatVersion: 1`)

```json
{
  "format": "fuli-occupation-plugins", "formatVersion": 1, "manifestVersion": 1, "updatedAt": "2026-11-06",
  "sources": [{ "id": "…", "repository": "https://github.com/owner/repo", "commit": "<40 hex>",
    "license": "MIT", "copyright": "Copyright (c) …", "licenseText": "<full text or null>" }],
  "plugins": [{
    "id": "testing", "version": "1.0.0", "occupations": ["testing", "qa_automation"],
    "role": { "source": "…", "path": "path/to/role.md", "name": "qa-expert" },
    "checklist": { "source": "…", "path": "…", "items": ["quoted line", "…"] },
    "acceptance": { "source": "…", "path": "…", "items": ["quoted line", "…"] },
    "skills": [{ "id": "…", "name": "…", "source": "…", "path": "skills/…", "summary": "upstream description" }],
    "mcpServers": [{ "id": "<registry name>", "name": "…", "source": "…", "path": null, "summary": "upstream description" }],
    "digest": "sha256:<64 hex>"
  }]
}
```

Rules the parser enforces (`src/occupation-plugins/manifest.js`):

- Licenses: only MIT, Apache-2.0, BSD-2/3-Clause, ISC, CC0-1.0, CC-BY-4.0. No license, non-commercial
  or source-available content is refused.
- `checklist` and `acceptance` are quoted text: their source must carry `licenseText` (and its copyright
  line), so the upstream notice travels with every copy. Skills and MCP servers are references only.
- One kit per occupation key. Occupation keys are the built-in catalog keys; a custom occupation has no kit.
- A plugin's `digest` is `sha256:` + the canonical-JSON hash of the plugin (without `digest`) and every
  source it names (`occupationPluginDigest`). A changed commit or license changes the digest. The digest
  identifies content; it never proves where a copy came from.
- Links are built from `repository`, `commit` and `path`, so they always point at the quoted revision.
- Changes to quoted text (as CC BY asks to indicate): items are a selection of the upstream list, keep its
  wording, and lose only Markdown markup (checkboxes, links, emphasis, priority badges); nested sub-items are
  joined to their item with "; ".

## Sources in manifest 1 (2026-11-06)

| Kit (occupations) | Checklist quoted from | Acceptance quoted from | Role file | Skills | MCP (suggestions) |
| --- | --- | --- | --- | --- | --- |
| engineering (engineering, backend, architecture) | google/eng-practices `looking-for.md` Summary (CC-BY-3.0) | gemini-cli-extensions/conductor Definition of Done 1–6 (Apache-2.0) | VoltAgent fullstack-developer (MIT) | superpowers TDD, systematic-debugging, verification-before-completion (MIT); wshobson code-review-excellence (MIT) | GitHub, Git |
| frontend (frontend, design) | Front-End-Checklist Accessibility, Critical rules (MIT) | Front-End-Checklist Performance, Core Web Vitals and load rules (MIT) | wshobson frontend-developer (MIT) | anthropics frontend-design (Apache-2.0); wshobson accessibility-compliance, design-system-patterns (MIT) | Playwright, Chrome DevTools |
| testing (testing, qa_automation) | Microsoft Engineering Playbook automated testing fundamentals (CC-BY-4.0) | Conductor Quality Gates (Apache-2.0) | wshobson ship-mate qa (MIT) | anthropics webapp-testing (Apache-2.0); wshobson e2e-testing-patterns, superpowers TDD (MIT) | Playwright, Chrome DevTools, GitHub |
| project-manager (project_manager, management) | Playbook Definition of Ready (CC-BY-4.0) | Playbook Definition of Done, Feature/User Story (CC-BY-4.0) | VoltAgent project-manager (MIT) | superpowers writing-plans, brainstorming (MIT) | GitHub |
| research (research) | wshobson search-specialist Approach (MIT) | search-specialist Output (MIT) | wshobson search-specialist (MIT) | K-Dense literature-review, citation-management (MIT) | Fetch, arXiv |
| writing (writing, documentation) | wshobson docs-architect Best Practices (MIT) | Playbook Markdown review checklist (CC-BY-4.0) | wshobson docs-architect (MIT) | wshobson avoid-ai-writing, architecture-decision-records, changelog-automation (MIT) | Filesystem, Git |

Left out on purpose: contains-studio/agents (no license), anthropics/skills `docx`/`pdf`/`pptx`/`xlsx` (proprietary)
and `doc-coauthoring` (no license), CC BY-SA texts (share-alike), and hosted-only MCP servers (Context7, Exa,
the Front-End-Checklist MCP), which do not fit a local-first product.

Curating: edit `registry/occupation-plugins.json`, raise the plugin `version` and `manifestVersion`, run
`node scripts/occupation-plugins-digest.js`, and merge to `main`. Installed FULIs pick it up within a day.

## Delivery: on demand, never in the task entry

- The task entry carries nothing of a kit (`test/token-budget.test.js` keeps the entry bytes unchanged).
  The shared continuity rule (referenced by version) says where the kit is.
- `read_occupation_kit` (full profile; chat reaches it through `list_agent_interfaces`/`fuli_call`) returns
  one kit: the quoted checklist and acceptance with their source URL and license, recommended Skills and
  MCP servers with `enabled` (`null` until the person answered), and `choice` (`outdated` when the kit
  changed since the answer).
- Skills are installed only when the person enabled them, from their `url`. MCP servers are suggestions:
  FULI never connects one and keys stay the person's.

## Bole and the person's answer

- `coordinate_project_agent_task` with a pending recruitment returns `occupation_kits` (plugin id@version and
  recommendation ids per occupation it would hire). The recruiting Agent shows the kit and asks the person once.
- `decide_project_agent_recruitment` takes `occupationKit: { skills: [ids], mcpServers: [ids] }`. On approval the
  answer is recorded for the recruited FLA (`answered_by: recruitment`); a non-matching answer leaves the approval
  as it is and returns `occupationKit.status: not_recorded` with the reason.
- The FLA page's 起步包 widget (`fla-kit`) shows the source, license and recommendations and lets the person
  turn each one on or off (`PUT /api/project-agents/:agentId/occupation-kit`, `agent_relayed` for Agents).
- The occupations page's quick look shows each occupation's kit with its source and license.

## Self-growth on top (rec#78)

The upstream kit is never edited. What a project learns sits beside it:

- A lesson is a `ReusableExperience` knowledge item (checkpoint `experiences`) in that project, proposed by an FLA
  that holds the occupation and kept by the person (`confirmation_status: confirmed`, the FLA page's 「保留」).
- An acceptance check learned in use is the same item with `attributes.check` (`{ kind: acceptance_item | regression_example, text }`, one line a reviewer can verify).
  The self-growth side writes it (`record_fla_lesson`) and owns its one reader, `projectAcceptanceChecks` in
  `src/acceptance-checks/port.js`; the kit reads its checks through that port.
- `read_occupation_kit` with `personalProjectId` adds `learned: { personalProjectId, partial, total, lessons[≤3],
  checks[≤10] }` (lessons: `itemId`, `title`, `solution`, `boundary`, `tasks`; checks: `itemId`, `check`, newest kept first). Only
  person-kept items appear; Tonborg and Jefa check work against the kit's `acceptance` plus these `checks`.
- History follows the knowledge rules: a dropped lesson soft-ends and leaves the layer; nothing is deleted.
