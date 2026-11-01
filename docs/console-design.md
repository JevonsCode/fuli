---
name: Console
description: A calm, precise workspace for human and Agent collaboration.
colors:
  background: "#f2f2ef"
  surface: "#ffffff"
  ink: "#17171a"
  muted: "#66666d"
  accent: "#17171a"
  gold: "#a8824a"
  border: "#e6e6e1"
  control-border: "#c4c4bd"
typography:
  body:
    fontFamily: "Inter Variable, Noto Sans SC Variable, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  control: "8px"
  card: "14px"
  dialog: "20px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
---

## Overview

The console is an operational workspace. Short titles, clear actions, real status and generous spacing take priority. Keep the existing product mark. Brand motion comes from the shared three-arc loading mark.

## Colors

The theme layers in `web/src/styles/theme/` are the source of truth; the one skin is direction A 「素」 (Jevons picked it on 2026-11-01 over an ink-stage-on-glass direction), in the spirit of Apple's own apps and Linear. The page is a plain neutral grey; content sits on white surfaces split by hairlines, grouped into inset lists; ink marks the main action and the current destination; gold means progress and nothing else (deep gold for links). There is no gradient wash or texture on the page: the character comes from type, spacing and restraint. Glass is kept for what floats over the page (the dock, its pins and their tooltips), so they read as above it. Shadows are a cool near-black and only lift what is selected or floating. Success, warning and danger colors communicate state. Use the chart palette only to distinguish graph categories. Muted text has at least 4.8:1 contrast on the main light surfaces; form boundaries use the dedicated control border.

## Typography

The console bundles Inter and Noto Sans SC (SIL OFL 1.1, `@fontsource-variable`); system fonts are fallbacks only and are never bundled. Primary content is 14–16px, page titles 25px and secondary labels 12px. Keep long content inside its detail view. Do not add instructional eyebrows or repeat the page title within its first section.

## Layout

The client shell has a top bar (brand and service dot, the page's one 22px H1, section tabs as words with an ink rule under the current one, then quiet round buttons for waiting requests and settings at the right), one scrolling content region, and a floating frosted-glass dock (like the macOS dock: translucent white with a live blur of what scrolls beneath) of round icon buttons left-aligned with the page: 工作台, FLAs, 圆桌, 沉淀, 项目. The current icon is ink over a gold dot that glides between buttons. Names are tooltips and accessible names. The dock stays open on the workbench and folds to the current destination elsewhere, opening on hover or focus. Pinned FLAs rise in their own glass capsule above the FLAs button; right-click offers the profile, its Workbench and Workflow when it has them, and unpinning.

FLAs (rewritten 2026-11-01, direction A) is one inset grouped list in a readable centred column, like an iOS settings list: groups by what each FLA is doing, what needs the person first (需要你看, 正在工作, 空闲, 状态未上报, 已停用), or by project with unassigned FLAs last. A row is the portrait, the name with occupation and FLA number, then the current work (a free, unreported or switched-off row shows what the FLA is for, since its heading already says the state), the time of the last change and a chevron. The whole row opens the FLA's page; right-click pins it to the dock or copies #FLA. Search and grouping live in the URL; rows keep their order while read, and a change of work offers a reorder instead of moving rows under the pointer.

Pages rebuilt on the D-03 layout (home, the Agent profile, settings, and the memory pages: knowledge, preferences, taste and organize) share one work canvas: centred, at most 1840px wide, with the top bar's title lined up with it. Wider screens add columns instead of stretching a card: collections use one to four columns by canvas width, and tables show their low-priority columns. Forms keep one 896px column. There is no list-beside-detail split: a name opens the record's own page, and a quick look opens a centred dialog whose `?item=` keeps it in the URL. Back restores the collection's filters, scroll and focus. The top bar is the only H1; a record page shows the record's name there, section tabs use state words, and no section repeats the title.

The home page is the 工作台: two equal halves on the client's default 1280×860 window and up. The left stage is fixed and never scrolls as a page: the piece of work you are looking at, its FLA arc (one segment per FLA, gold when its part is finished, never a made-up percentage), its recorded progress and what each FLA is doing. The right column scrolls on its own: 等你处理 (only when something waits), the other work in progress (a click puts it on the stage, its title flying across), and 最近完成. Very wide screens keep the halves inside the centred canvas, with the top bar and dock aligned to it; below 860px everything stacks in one scrolling column. Agent profiles lead with an overview of current work; history, collaboration, conversations and management use tabs. A knowledge item, a preference or an organizer row opens its details in the shared knowledge quick look (`KnowledgePeek`); a knowledge item stays in its path (`/knowledge/.../<kind>/<id>`) and a preference or organizer row in `?item=<space>/<kind>:<id>`, so a link or a refresh reopens it, opening pushes it, and Esc or Back closes it and returns focus to the opener, and while an edit, confirm or project form opened from it is up the quick look steps aside and returns on the same item. Taste rules are a card collection. Settings uses a few topic tabs over one form with card groups; low-frequency items sit in accordion sections, and the save area ends the form. Secondary configuration and explanations use disclosures.

Graph labels follow zoom level. Below 0.72, retain project names and reveal other labels on hover, keyboard focus, selection or search. Keep accessible names and original labels available at every scale.

The About page sits on the light canvas like every other page: the FULI promise, then one 我们的理念 section (each principle a headline and one sentence, two or three columns on wider screens), the label system and the open-source credits. A principle states only what the product does today. Keep the closing section visible rather than collapsible, with its official-site link.

## Widgets

Movable pieces are widgets (Jevons 11-01: modular, easy to move, open to a person's own workbench later). A widget reads its own data, takes only the context its slot passes, and assumes nothing about where it sits. `web/src/widgets/registry.ts` names each widget and the slots it may sit in; `web/src/widgets/layout.ts` says which widgets each slot shows (one code default today, shaped as plain data a saved layout can replace); pages and the shell render a `WidgetSlot`. Moving a widget is a layout change. Slots today: `workbench.feed` (团队卡片), `shell.aboveDock` (悬浮岛) and `fla.overview`.

团队卡片 shows one task several FLAs do together: overlapping portraits (the lead slightly larger), a thin ring per portrait filled to that share's recorded progress (no ring without recorded steps), and a soft breath on whoever is doing a step now. Opening it, by height on the shared motion, lists each share's to-do steps and bar. The 悬浮岛 floats above the dock on every page only while such a task runs: 「3 位 FLA 正在一起做「…」 5/8」. Hover or click grows it upward into the same card, with switching when several run; Esc or a click elsewhere folds it back. On 工作台, 进行中 no longer repeats a task that has a team card.

## Elevation & Depth

Cards use a light border without decorative shadow. A selected or previewed card lifts: full surface, a stronger hairline and a light shadow, never a side accent bar; the focus ring stays a separate outline. Reserve the shared popover and dialog shadows for floating surfaces. Avoid nested boxes around ordinary list rows.

## Motion

Motion is named by meaning in `web/src/styles/theme/base.css`: `--motion-enter` (arriving, on the spring), `--motion-exit` (leaving, fast) and `--motion-move` (gliding to a new place). Rules use these pairs, never a literal duration. Motion never holds up the person: page transitions let clicks through to the new page, a leaving list item drops out of the flow and out of hit testing at once, and every transition can be interrupted mid-way. Collections animate through `<TransitionGroup name="ui-list">` (`web/src/styles/motion.css`), and disclosures open and close by their height where the browser can animate to `auto`.

Motion is lively but brief. Things that appear or move use one spring with a small overshoot (`--motion-ease-spring` in CSS, `SPRING` for motion-v in `web/src/lib/motion.ts`); things that leave use a soft ease-out. Page changes cross-fade and rise through the View Transitions API while the top bar and dock stay put; an in-page tab change does not animate. The dock's ink pill glides to the current destination (a motion-v shared layout), pinned FLAs rise one after another, and popovers and dialogs pop in on the spring. GSAP is not used: its licence is not an open-source one. The system setting and the in-app switch both turn all of it off.

## Shapes

Controls, cards and dialogs use the shared 10/16/20px radii. Keep spacing on the 4px scale. Compact state badges may use smaller radii; do not invent a separate page-specific button system.

## Components

- shadcn-vue components in `web/src/components/ui` (Button, Dialog, Tabs, Card, Accordion, DropdownMenu, Badge) own their controls; pages use them as they are rather than wrapping them. Preserve native button refs when focus restoration depends on them.
- `TextField`, `SearchableSelect` and native form controls share 40px sizing, readable labels, focus rings and control boundaries.
- `UiDisclosure` keeps optional detail reachable with a native summary. An invalid settings field opens its tab and section, takes focus and names itself beside the save button.
- `GrowthLoading` provides page, compact and inline forms of one three-arc SVG animation. The loading composable delays the mark by 120ms and keeps a revealed mark for at least 180ms. Reduced motion renders the static mark. Refreshing data preserves existing content.
- Member availability and task status are distinct. Missing, failed or truncated task data must never be presented as idle.

Attention requests appear in a selectable queue; mobile options retain the Agent, project and request title. Convert only source text that explicitly presents consecutive A/B alternatives into choices. Keep numbered steps and natural-language questions as source text. Quick replies depend on request kind and fill a draft; sending remains a separate explicit action. Keep drafts isolated by request and revision. When a revision changes, clear the stale choice, mark the update, and retain free text only as an unsent draft for review.

Interaction references: [Apple loading guidance](https://developer.apple.com/design/human-interface-guidelines/loading) and [Material responsive navigation](https://m2.material.io/components/navigation-drawer/android) and [Material confirmation dialogs](https://github.com/material-components/material-components-web/blob/master/packages/mdc-dialog/README.md#confirmation-dialog).

## Do's and Don'ts

- Keep the primary action visible; disclose secondary details.
- Keep permissions, scope, history, confirmation and task links intact.
- Localize interface text in Chinese and English; leave user content unchanged.
- Reuse tokens and primitives; delete replaced styles and unused UI copy.
- Do not fabricate activity, progress percentages or empty states before requests complete.
- External embedded employee apps retain their own implementation boundary.
