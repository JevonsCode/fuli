# Fuli Public Site Design

Scope: the static product website in `site/`. This document describes the current
`site/index.html`, `site/style.css`, `site/styles/scenes.css`,
`site/styles/responsive.css`, `site/site.js`, and `site/scroll-state.js`.
Styles load in that order: shared styles and static sections, scroll scenes, then
motion fallbacks and responsive rules. Keep the bundled font URL in `site/style.css`.
The operational console in `web/` has its own design language.

## Direction and narrative

An editorial product launch: a black-and-gold brand object opens the page, then
warm white and pale sage surfaces explain the actual architecture. Scroll motion
reveals relationships and stages; the content must also work as a static document.

Reading order:

1. Original Fuli logo and the promise “每次合作，都有复利。”
2. Continuity across supported Agent clients.
3. Four architecture boundaries, progressively emphasized.
4. Four stages of the knowledge loop, with a labeled illustrative evidence panel.
5. Distinct visual stories for preferences, bounded memory, and knowledge history.
6. Personal-edition installation, product boundaries, and source links.

Use generous space and short Chinese headlines. Capability illustrations should
explain a mechanism; avoid turning every section into identical feature cards.

## Brand and material

- Use `site/assets/fuli-logo.png`, sourced from `web/assets/brand/fuli-logo.png`.
  Keep the original image proportions and colors; do not redraw or replace it.
- The hero presents the logo on a warm metallic circular face. Orbit lines connect
  identity, memory, and judgment. These are conceptual illustrations, not live data.
- Restrained gradients, soft shadows, perspective, and header blur are intentional.
  Apply them to the hero object, spatial layers, and selective emphasis.
- Architecture uses pale sage layers, thin connectors, a dark application core,
  and a dashed external-source boundary. Depth should make the hierarchy legible.

## Palette and typography

| Token / role | Current value |
| --- | --- |
| `--dark` / hero, workflow, install | `#101110` |
| `--paper` / reading surfaces | `#f5f5f1` |
| `--ink` / primary light-surface text | `#20221f` |
| `--muted` / secondary text | `#696c65` |
| `--gold` / active states and accents | `#d5b776` |
| `--line` / neutral dividers | `#dedfd7` |
| Architecture background | `#eaece5` |
| Application core | `#20291f` |
| Primary button | `#ead7ac` with dark text |

Chinese copy uses Arial, PingFang SC, Microsoft YaHei, then sans-serif. The bundled
Unbounded font is reserved for the Latin brand, counters, and the large memory
number. Installation commands use SFMono-Regular / Consolas / monospace.

Desktop hero type is `clamp(52px, 5.8vw, 86px)` with 1.16 line height. Main section
headlines use approximately 40–64px, with smaller chapter headings. Body copy uses
relaxed 1.8–1.9 line height and restrained reading widths. Preserve legibility when
adjusting muted labels, especially on sage and dark surfaces.

## Layout and components

- Shared content width: 1600px maximum; gutter `clamp(24px, 6vw, 100px)`.
- Desktop header: 76px. With JavaScript it is fixed, translucent, and carries a
  thin scroll-progress line plus current-section navigation.
- Architecture: copy beside layered diagram. Workflow: four connected steps above
  explanatory copy and evidence rows. Keep the two compositions distinct.
- Primary buttons are 48px-high pills. Feature panels use 22px corners; architecture
  and evidence layers use approximately 13px corners. Use thin borders consistently.
- FAQ uses native `details` / `summary`. Commands remain selectable and can scroll
  horizontally inside the code block. Clipboard feedback uses a live status region.
- Keep meaningful headings, figure captions, diagram labels, visible focus states,
  a skip link, and descriptive control names. Decorative geometry is aria-hidden.

## Scroll behavior and fallbacks

- `site.js` enhances the document only after initialization by adding `.js`.
  The unenhanced HTML contains every chapter in reading order.
- Scroll handling uses passive listeners and one scheduled animation frame.
  `scroll-state.js` owns progress, stage selection, and stage-scroll calculations.
- In full-motion mode the hero spans 165svh. Its sticky object scales and shifts
  while the heading fades with scroll progress.
- Architecture and workflow each have four stages. Desktop scenes span 360svh;
  sticky content sits beneath the header. Scroll emphasizes the corresponding
  diagram layer or evidence row and reveals the matching caption.
- Chapter buttons provide another route to each stage. Preserve `aria-pressed`,
  the visible stage counter, anchor navigation, and the footer motion control.
- General section reveals run once as content enters view; they must never be
  the only way essential content becomes available.
- Honor `prefers-reduced-motion` and the explicit footer preference. System reduced
  motion takes priority. Reduced mode removes long scene heights, transitions,
  transforms, and hidden captions; all chapters and diagram layers remain visible.
- With no JavaScript, every caption remains readable, the native FAQ still works,
  and command text is present. Hide controls that depend on JavaScript.

## Responsive rules

- 1100px and 900px refine spacing, diagram labels, and desktop columns.
- **700px is the mobile breakpoint**; JavaScript uses the matching minimum 701px
  desktop query. Navigation becomes a toggleable menu, major layouts stack, and
  scene geometry/type shrink. Do not invent a separate 768px breakpoint.
- **735px viewport height is the short-screen cutoff.** Long sticky scenes become
  static, all captions and diagram layers show, and scroll-stage animation stops.
  Wider layouts may keep the accompanying figure sticky; at 700px and below the
  figure and evidence panel are static too.
- A separate maximum-height 850px / minimum-width 901px rule compacts desktop
  scenes. At 360px and below, gutters and dense diagram labels reduce further.
- Reduced motion and no-JavaScript layouts must stay readable at every breakpoint.
  Check narrow phones, short landscape screens, and a full desktop viewport.

## Product truth in diagrams and copy

- Agent clients use MCP and client lifecycle adapters. The management UI uses HTTP.
  Both are peers of the same application services, not a UI-driven Agent pipeline.
- Application services enforce project scope, preferences, retrieval, and review.
  Personal Provider connects to local Neo4j. Private conversations, working memory,
  and confirmed knowledge remain separate concerns; history is preserved.
- External knowledge is project-bound and read-only. Do not draw a writeback path
  to Notion, Feishu, MCP sources, or custom connectors.
- The workflow is context → focused retrieval → real use and feedback → a durable
  candidate or `retain_nothing`. Retrieval alone does not count as knowledge use.
- Seven days describes the default conversation inactivity/archive window, not a
  deletion deadline. Context recovery is bounded, with details retrieved on demand.
- Cross-client continuity depends on installed, trusted adapters and saved context;
  it does not transfer filesystem or native tool state or promise seamless recovery.
- Only `fuli-context` personal edition is released. The independent team server is
  in development. Personal taste, personality, and judgment stay out of shared data.
- Installation: `npm install --global fuli-context`, `fuli setup`, then `fuli open`.
  Require Node.js 24.12+; the default container mode requires Docker Compose v2.
- Label illustrative preferences and process panels as examples. Do not invent
  production metrics, client coverage, customer evidence, or quantified savings.

Validate future claims against `README.zh-CN.md`, `docs/agent-interface-architecture.md`,
`docs/agent-conversations-and-collaboration.md`, and
`docs/external-knowledge-architecture.md` before changing public copy.
