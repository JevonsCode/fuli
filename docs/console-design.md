---
name: Console
description: A calm, precise workspace for human and Agent collaboration.
colors:
  background: "#f6f7f9"
  surface: "#ffffff"
  ink: "#1d2129"
  muted: "#606b7d"
  accent: "#2563eb"
  accent-soft: "#edf3ff"
  border: "#e2e5ea"
  control-border: "#8791a2"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, Segoe UI, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "14px"
    lineHeight: 1.5
  title:
    fontSize: "25px"
    fontWeight: 650
    lineHeight: 1.25
rounded:
  control: "10px"
  card: "16px"
  dialog: "20px"
spacing:
  small: "8px"
  medium: "16px"
  large: "24px"
---

## Overview

The console is an operational workspace. Short titles, clear actions, real status and generous spacing take priority. Keep the existing product mark. Brand motion comes from the shared three-arc loading mark.

## Colors

The theme layers in `web/src/styles/theme/` are the source of truth; the one skin is 墨与金 (ink and gold, 2026-11-01). Panels are translucent glass over a pre-blurred paper-grey wash; ink marks the main action and the current destination; champagne gold carries progress, links and the warm shadows. Success, warning and danger colors communicate state. Use the chart palette only to distinguish graph categories. Muted text has at least 4.8:1 contrast on the main light surfaces; form boundaries use the dedicated control border.

## Typography

The console bundles Inter and Noto Sans SC (SIL OFL 1.1, `@fontsource-variable`); system fonts are fallbacks only and are never bundled. Primary content is 14–16px, page titles 25px and secondary labels 12px. Keep long content inside its detail view. Do not add instructional eyebrows or repeat the page title within its first section.

## Layout

The client shell has a top bar (brand and service dot, the page's one H1, section tabs, then waiting requests and settings at the right), one scrolling content region, and a floating dock of round icon buttons left-aligned with the page: 工作台, FLAs, 圆桌, 沉淀, 项目. Names are tooltips and accessible names. The dock stays open on the workbench and folds to the current destination elsewhere, opening on hover or focus. Pinned FLAs rise in their own capsule above the FLAs button; right-click offers the profile, its Workbench and Workflow when it has them, and unpinning. Only the dock and the pins capsule use a live blur.

Pages rebuilt on the D-03 layout (home, the Agent directory and profile, settings, and the memory pages: knowledge, preferences, taste and organize) share one work canvas: centred, at most 1840px wide, with the top bar's title lined up with it. Wider screens add columns instead of stretching a card: collections use one to four columns by canvas width, and tables show their low-priority columns. Forms keep one 896px column. There is no list-beside-detail split: a name opens the record's own page, and a quick look opens a centred dialog whose `?item=` keeps it in the URL. Back restores the collection's filters, scroll and focus. The top bar is the only H1; a record page shows the record's name there, section tabs use state words, and no section repeats the title.

The home page leads with pending decisions, followed by current work and recent projects. Agent profiles lead with an overview of current work; history, collaboration, conversations and management use tabs. A knowledge item, a preference or an organizer row opens its details in the shared knowledge quick look (`KnowledgePeek`); a knowledge item stays in its path (`/knowledge/.../<kind>/<id>`) and a preference or organizer row in `?item=<space>/<kind>:<id>`, so a link or a refresh reopens it, opening pushes it, and Esc or Back closes it and returns focus to the opener, and while an edit, confirm or project form opened from it is up the quick look steps aside and returns on the same item. Taste rules are a card collection. Settings uses a few topic tabs over one form with card groups; low-frequency items sit in accordion sections, and the save area ends the form. Secondary configuration and explanations use disclosures.

Graph labels follow zoom level. Below 0.72, retain project names and reveal other labels on hover, keyboard focus, selection or search. Keep accessible names and original labels available at every scale.

The About page uses its dark ink treatment across the full page. Keep the closing section visible rather than collapsible, with its official-site link.

## Elevation & Depth

Cards use a light border without decorative shadow. A selected or previewed card lifts: full surface, a stronger hairline and a light shadow, never a side accent bar; the focus ring stays a separate outline. Reserve the shared popover and dialog shadows for floating surfaces. Avoid nested boxes around ordinary list rows.

## Motion

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
