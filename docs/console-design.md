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

`web/src/styles/tokens.css` is the source of truth. Use neutral surfaces and blue for actions and selection. Success, warning and danger colors communicate state. Use the chart palette only to distinguish graph categories. Muted text has at least 4.8:1 contrast on the main light surfaces; form boundaries use the dedicated control border.

## Typography

Use the system font stack. Primary content is 14–16px, page titles 25px and secondary labels 12px. Keep long content inside its detail view. Do not add instructional eyebrows or repeat the page title within its first section.

## Layout

Desktop uses a 224px sidebar, a concise top bar and one scrolling content region. At 920px and below, navigation becomes a keyboard-accessible drawer.

Pages rebuilt on the D-03 layout (home, the Agent directory and profile, settings, and the memory pages: knowledge, preferences, taste and organize) share one work canvas: centred, at most 1840px wide, with the top bar's title lined up with it. Wider screens add columns instead of stretching a card: collections use one to four columns by canvas width, and tables show their low-priority columns. Forms keep one 896px column. There is no list-beside-detail split: a name opens the record's own page, and a quick look opens a centred dialog whose `?item=` keeps it in the URL. Back restores the collection's filters, scroll and focus. The top bar is the only H1; a record page shows the record's name there, section tabs use state words, and no section repeats the title.

The home page leads with pending decisions, followed by current work and recent projects. Agent profiles lead with an overview of current work; history, collaboration, conversations and management use tabs. A knowledge item, a preference or an organizer row opens its details in the shared knowledge quick look (`KnowledgePeek`); a knowledge item stays in its path (`/knowledge/.../<kind>/<id>`) and a preference or organizer row in `?item=<space>/<kind>:<id>`, so a link or a refresh reopens it, opening pushes it, and Esc or Back closes it and returns focus to the opener, and while an edit, confirm or project form opened from it is up the quick look steps aside and returns on the same item. Taste rules are a card collection. Settings uses a few topic tabs over one form with card groups; low-frequency items sit in accordion sections, and the save area ends the form. Secondary configuration and explanations use disclosures.

Graph labels follow zoom level. Below 0.72, retain project names and reveal other labels on hover, keyboard focus, selection or search. Keep accessible names and original labels available at every scale.

The About page uses its dark ink treatment across the full page. Keep the closing section visible rather than collapsible, with its official-site link.

## Elevation & Depth

Cards use a light border without decorative shadow. A selected or previewed card lifts: full surface, a stronger hairline and a light shadow, never a side accent bar; the focus ring stays a separate outline. Reserve the shared popover and dialog shadows for floating surfaces. Avoid nested boxes around ordinary list rows.

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
