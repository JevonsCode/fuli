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

Desktop uses a 224px sidebar, a concise top bar and one scrolling content region. At 920px and below, navigation becomes a keyboard-accessible drawer. Desktop Agent cards measured 276px wide with 16px grid spacing; the directory uses three, two or one columns according to available width. Knowledge inspectors stack below the list on smaller screens and stay hidden until an item is selected.

The home page leads with pending decisions, followed by current work and recent projects. Agent profiles lead with current work; history, collaboration, conversations and management use tabs. Secondary configuration and explanations use disclosures.

Graph labels follow zoom level. Below 0.72, retain project names and reveal other labels on hover, keyboard focus, selection or search. Keep accessible names and original labels available at every scale.

The About page uses its dark ink treatment across the full page. Keep the closing section visible rather than collapsible, with its official-site link.

## Elevation & Depth

Cards use a light border without decorative shadow. Reserve the shared popover and dialog shadows for floating surfaces. Avoid nested boxes around ordinary list rows.

## Shapes

Controls, cards and dialogs use the shared 10/16/20px radii. Keep spacing on the 4px scale. Compact state badges may use smaller radii; do not invent a separate page-specific button system.

## Components

- `UiButton` and the shared button classes own action styling. Preserve native button refs when focus restoration depends on them.
- `TextField`, `SearchableSelect` and native form controls share 40px sizing, readable labels, focus rings and control boundaries.
- `UiDisclosure` keeps optional detail reachable with a native summary. Invalid settings fields reveal their enclosing sections.
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
