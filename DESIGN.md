---
name: Fuli Site
description: An Apple-like Chinese spatial narrative for local-first Agent continuity.
colors:
  paper: "#f5f5f7"
  white: "#ffffff"
  ink: "#1d1d1f"
  muted: "#6e6e73"
  accent: "#087b63"
  accent-deep: "#168265"
  focus: "#00896b"
  scene-current: "#23866b"
  dark: "#111718"
  terminal: "#1b2422"
  line: "#d6dad7"
  jade: "#8bc1a8"
  silver: "#d8dfdc"
  carbon: "#25352e"
typography:
  display:
    fontFamily: "Unbounded, sans-serif"
    fontSize: "clamp(90px, 14vw, 230px)"
    fontWeight: 550
    lineHeight: 1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(42px, 4.5vw, 72px)"
    fontWeight: 650
    lineHeight: 1.14
    letterSpacing: "-0.035em"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "12px"
    fontWeight: 500
    lineHeight: 1.2
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "clamp(12px, 1.2vw, 16px)"
    fontWeight: 400
    lineHeight: 2.3
rounded:
  fragment: "9px"
  panel: "16px"
  action: "28px"
  circle: "50%"
spacing:
  gutter: "clamp(24px, 7vw, 120px)"
  header: "72px"
  chapter: "120px"
  action: "15px 24px"
  stage: "100svh"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.white}"
    rounded: "{rounded.action}"
    padding: "{spacing.action}"
    height: "48px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "0"
    padding: "0"
    height: "18px"
  site-nav:
    backgroundColor: "rgba(245, 245, 247, 0.96)"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "0 {spacing.gutter}"
    height: "{spacing.header}"
  install-terminal:
    backgroundColor: "{colors.terminal}"
    textColor: "#e9f1ee"
    rounded: "{rounded.panel}"
    padding: "36px 30px"
  faq-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "22px 0"
  fragment:
    backgroundColor: "{colors.jade}"
    textColor: "#163b2b"
    rounded: "{rounded.fragment}"
    padding: "15px 16px"
    width: "180px"
    height: "116px"
  static-diagram:
    backgroundColor: "#e8eae8"
    textColor: "#284f44"
    rounded: "{rounded.panel}"
    padding: "28px"
  motion-toggle:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "0"
    padding: "7px 0"
    height: "28px"
---

# Design System: Fuli Site

## Overview

**Creative North Star: “The Continuity Object”**

The public site is a Chinese, Apple-like spatial product narrative. Large restrained typography gives the promise room to land while one physical-looking object carries the explanation. Twelve reusable CSS3D fragments begin scattered, then assemble and recompose as the visitor scrolls. The same object becomes a readable model of identity, architecture, client continuity, memory, taste, and team coordination.

The experience uses native document scrolling and progressive enhancement. The HTML chapters, static diagrams, manifesto, local setup, questions, and footer remain the reading surface. JavaScript adds a sticky full-viewport stage, scroll-scrubbed transforms, changing captions, and scene overlays when motion is appropriate. The public page remains scoped to `site/`; the operational console has its own visual language.

**Key Characteristics:**

- Porcelain paper, carbon black, silver, and jade create a quiet physical palette.
- One twelve-piece object moves through seven authored poses instead of a feature-card grid.
- Chinese headlines are large and measured; small labels explain mechanism and material.
- CSS perspective, six-sided fragments, inset highlights, and one ground shadow provide depth.
- Architecture is explicit: adapters, Fuli orchestration, Python Provider, and Neo4j storage are named.
- Static, reduced-motion, short-viewport, and no-JavaScript paths keep the product story available.

## Colors

The interface starts on `#f5f5f7` and uses near-black type with a restrained jade signal. The dark architecture chapter and carbon fragments supply contrast; green marks continuity, confirmation, and action.

### Primary

- **Ink** (`#1d1d1f`): page text, brand, headings, and the primary action.
- **Jade Accent** (`#087b63`): links and continuity cues.
- **Deep Jade** (`#168265`): confirmed continuation emphasis in the setup example.
- **Focus Jade** (`#00896b`) and **Scene Jade** (`#23866b`): keyboard focus and current chapter marks.

### Secondary

- **Carbon Surface** (`#111718`): the architecture chapter and manifesto surface.
- **Terminal Surface** (`#1b2422`): the installation command panel.

### Neutral

- **Porcelain Paper** (`#f5f5f7`): page background, header, and the default scene ground.
- **White** (`#ffffff`): setup surface, fragment highlights, and static diagram tags.
- **Muted Text** (`#6e6e73`): supporting copy and quiet actions.
- **Rule Gray** (`#d6dad7`): FAQ, footer, and setup separators.

### Fragment materials

- **Silver:** `#ffffff → #f0f2f1 → #d8dfdc` across the front face.
- **Jade:** `#d4f3e5 → #8bc1a8 → #4c9578` across the front face.
- **Carbon:** `#45524e → #25352e → #17261e` across the front face.

**The Shared Object Rule.** Every narrative pose keeps the same twelve fragments. Arrangement, labels, opacity, and camera angle change so continuity reads as a transformation of one system.

## Typography

**Display Font:** Unbounded, loaded from the local `unbounded-latin.woff2` asset for the FULI stage word and available fragment display variants.
**Body Font:** `-apple-system, BlinkMacSystemFont, "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif` for Chinese and interface copy.
**Label/Mono Font:** the body stack for metadata; `ui-monospace, SFMono-Regular, Menlo, monospace` for installation commands.

The type system is quiet and spacious. The large Chinese `h1` and `h2` deliberately use the platform-native Chinese grotesk stack so PingFang SC and Microsoft YaHei carry the page's primary voice on their native platforms. Unbounded is reserved for the Latin object mark and counter-like display treatment; this is an intentional display-type split. Weight and size do the work, with tight tracking on large statements and a 1.7 reading rhythm for ordinary copy.

### Hierarchy

- **Display** (550, `clamp(90px, 14vw, 230px)`, line-height 1): the translucent `FULI` stage word.
- **Headline** (650, `clamp(42px, 4.5vw, 72px)`, line-height 1.14, `-0.035em`): hero and chapter statements.
- **Body** (400, 16px base, line-height 1.7): explanatory copy; chapter lead text grows to `clamp(17px, 1.4vw, 21px)`.
- **Label** (500, 12px, line-height 1.2): navigation, captions, material labels, and metadata.
- **Mono** (400, `clamp(12px, 1.2vw, 16px)`, line-height 2.3): the three-line install command.

**The Two-Voice Rule.** Keep large Latin identity in Unbounded and let the system sans stack carry Chinese product communication.

## Layout

The header is an absolute 72px bar with `clamp(24px, 7vw, 120px)` horizontal gutters. The ordinary document uses centered chapter content with `120px` vertical padding and a `650px` minimum chapter height. Hero copy stays left aligned, with the stage reserved for the spatial object.

When enhancement is enabled, `.spatial-stage` becomes a sticky `100svh` canvas with a `620px` minimum height. The chapters overlap the stage and grow to `155svh` so each scene has reading dwell before the next transformation. The hero is `135svh`; the final team chapter is `140svh`. Chapter copy stays sticky around `29svh`, hero copy around `34svh`, and fades with scroll position. The implementation uses passive scroll listeners and `requestAnimationFrame`; it does not hijack the scroll gesture.

The stage uses a `1400px` perspective. On wide screens it scales to `1.5`; at `1050px` it reduces to `0.88`. At `700px`, the header becomes 64px, the gutter becomes 24px, the copy fills the width, the object moves toward the lower half of the stage, and the chapter navigation moves to the bottom edge. Key client and team labels stay around 11–12px on mobile while supporting stage legends reduce to 8–10px. The second header link is hidden on mobile. A `380px` width gets a smaller scene scale.

Below the journey, the manifesto uses the carbon surface, the setup section uses a white surface with a two-column command-and-steps layout, questions use a two-column disclosure layout, and the footer closes the page with a compact brand row. Setup and questions stack vertically on mobile.

## Elevation & Depth

Depth comes from authored geometry rather than a broad card elevation system. Each fragment is `180px × 116px`, uses `preserve-3d`, six faces, `9px` corners, and a `7px` front/back offset. The stage perspective, material gradients, inset highlights, translucent radial atmosphere, and one blurred ground shadow make the object feel placed in space. The manifesto, setup, and FAQ sections use tonal surfaces and one-pixel rules to keep the reading surface calm.

### Shadow Vocabulary

- **Fragment inset:** `inset 0 1px 1px #fff, inset 0 -1px 1px #a8b6ae`; edge definition on silver faces. Jade and carbon use their own material-specific inset values.
- **Object ground:** `background: #31534225` with `filter: blur(24px)`; a single ambient shadow beneath the rig, reduced during the dark architecture scene.
- **Stage atmosphere:** radial gradient `#dfeae580 0%, #ebefed25 48%, transparent 70%`; a soft field behind the object.

**The Material-Only Depth Rule.** Use the existing fragment materials, perspective, atmosphere, and ground shadow for spatial depth. Keep lower-page surfaces clean and avoid adding unrelated decorative elevation.

## Shapes

The form language mixes a rounded physical fragment with restrained utility controls: fragments use `9px` corners, static diagram tags use `6px`, large setup panels use `16px`, and pill-like primary actions use `28px`. Circular seals, scene dots, and step markers use `50%`. SVG icons are inline paths with `1.6px` strokes, round caps, and round joins. The shared focus state is a `3px` jade outline with a `6px` offset; selection uses `#b6ebda` with `#11382d` text.

## Components

### Spatial fragment rig

The signature component is twelve generated `.fragment` elements inside a `preserve-3d` rig. Each face carries a short public mechanism label and three quiet bars. The source materials are silver, jade, and carbon. `scroll-scene.js` maps the same fragments through these seven poses:

| Pose | Source scene | Meaning shown in the page |
| --- | --- | --- |
| Scatter | `scatter` | Experience exists as separate pieces before continuity is formed. |
| Identity | `identity` | Identity, project, dialogue, taste, context, collaboration, source, judgment, memory, history, permission, and expectation compose one Agent. |
| Architecture | `architecture` | Client adapters anchor the connector layer above Fuli CLI/MCP/HTTP, Python Provider, and Neo4j relationship/history storage. |
| Cross-client | `continuity` | Codex, Claude Code, and Cursor route through their connectors to the same Agent and reachable data when Fuli integration is present. |
| Memory 7 days | `memory` | Visible records remain saved; recent context uses the default seven-day inactivity window, while older records become compact archive context and the current context is restored within a budget. |
| Taste | `taste` | Taste, personality, and judgment preferences carry source and scope; inference waits for human confirmation. |
| Team | `team` | HR matches, a group lead coordinates, specialist Agents execute and validate, and Jefa follows progress and delivery. |

The architecture overlay is a public mechanism diagram with anchored layers and connector labels. The cross-client overlay routes three client labels to one identity label and uses `Lin` as an explicitly illustrative role. The team overlay keeps HR, group lead, specialist Agent, and Jefa as floating stage labels. It carries no private project data.

### Navigation and actions

The header keeps a quiet paper surface, a compact Fuli mark, links to architecture, memory, and setup, and a GitHub link with an external-arrow SVG. The primary action is an ink pill with white text, `15px 24px` padding, a 48px minimum height, and a `28px` radius. The quiet action is an unboxed text link with a directional SVG. Hover shifts the ink or accent; keyboard focus uses the shared jade outline.

### Manifesto and principle notes

The manifesto is a large carbon statement: “工具会更新。模型会进化。你们的默契，值得留下。” Three notes below it make the philosophy concrete: local-first personal data, on-demand context, and human control over confirmation, revision, and collaboration boundaries.

### Install terminal and setup flow

The setup section presents the actual public path:

1. Run `npm install -g fuli-context`.
2. Run `fuli setup`, then `fuli open` to establish the local space and connect the Provider and database.
3. Configure Codex, Claude Code, or Cursor to reach the same data, then use the personal page's continuation instruction. A stable Agent ID resolves duplicate names.

The terminal is a `#1b2422` panel with `Node.js 24.12+` metadata. The copy utility is revealed by JavaScript and falls back to selecting the command when clipboard access is unavailable. The continuation example is explicitly a demonstration; the page does not present it as a real person's data.

### Questions and disclosure

Native `<details>` rows answer adapter-dependent mentions, seven-day archiving versus deletion, the separation of private conversations from trusted reusable knowledge, confirmation of inferred preferences, and the current personal-local scope. Preserve native disclosure behavior and the one-pixel rule treatment.

### Motion and access paths

- **Enhanced:** `site.js` enables the scene when `prefers-reduced-motion` is off and the viewport is taller than 560px. Scroll interpolation updates the camera, fragment transforms, opacity, scene background, overlay labels, caption, and chapter dots.
- **Reduced motion:** a system reduce preference or the footer toggle disables the scene and keeps the ordinary chapters and static diagrams. CSS removes transitions, animations, and smooth scrolling. The system-controlled toggle is disabled and reports that it is following the system preference.
- **Short viewport:** `max-height: 560px` follows the readable document path so the stage does not compete with the copy.
- **No JavaScript:** the module never adds `.enhanced`; `.spatial-stage` stays hidden, static chapter diagrams stay in the document, and setup, questions, links, and footer remain usable.
- **Keyboard and semantics:** the skip link targets `#main`, headings label chapters, nav and disclosures use native elements, and focus-visible states remain available in every path.

## Do's and Don'ts

### Do:

- **Do** keep the design system scoped to the public `site/` surface and describe values that exist in its source.
- **Do** use large restrained Chinese type with generous empty space around the spatial object.
- **Do** keep the same twelve fragments across all seven poses and let scroll explain the relationship between them.
- **Do** retain the static diagrams, seven-day memory boundary, source/scope/confirmation language, and local setup instructions.
- **Do** preserve native scrolling, reduced-motion behavior, short-viewport fallback, and no-JavaScript readability.
- **Do** keep fictional examples labeled and publish only public product facts.

### Don't:

- **Don't** replace the spatial object with a node-and-path diagram or flat panel grid.
- **Don't** replace the spatial object with repeated feature cards, synthetic activity, or private project evidence.
- **Don't** imply that every client has a native `@Agent` menu, captures complete transcripts, or supports an unavailable adapter.
- **Don't** describe the seven-day window as deletion or claim that a team server package is already released.
- **Don't** add decorative gradients, blur, or elevation outside the established stage material language.
