---
name: Fuli Site
description: A diagram-led Chinese landing page for local-first Agent continuity.
colors:
  ink: "#17392c"
  mint: "#ddebdf"
  paper: "#f7f9f5"
  muted: "#4c6659"
  line: "#b2c7b9"
  citron: "#deef73"
  blue: "#254fe6"
typography:
  display:
    fontFamily: "Unbounded, sans-serif"
    fontSize: "clamp(100px, 20.7vw, 320px)"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(42px, 5.3vw, 82px)"
    fontWeight: 750
    lineHeight: 1.22
    letterSpacing: "-0.035em"
  title:
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "clamp(33px, 3.55vw, 54px)"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  body:
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.9
  label:
    fontFamily: "PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.7
rounded:
  xs: "4px"
  sm: "6px"
  md: "7px"
  circle: "50%"
spacing:
  gutter: "clamp(22px, 5vw, 88px)"
  button: "17px 23px"
  section: "110px"
  story-step: "145px 0 100px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "{spacing.button}"
    height: "54px"
  button-light:
    backgroundColor: "{colors.citron}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "{spacing.button}"
    height: "54px"
  button-utility:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    rounded: "{rounded.xs}"
    padding: "9px 12px"
    height: "38px"
---

# Design System: Fuli Site

## Overview

**Creative North Star: "The Continuous Context Ribbon"**

This system documents the public static site in site/ only. A quiet mint ground, forest ink, and vivid state signals make continuity feel like a visible relationship graph. Circles, rings, paths, and short labels explain the mechanism before prose fills in detail.

The geometric Latin wordmark and compact Chinese copy carry one node-and-path vocabulary through the hero orbit, sticky story stage, and cobalt interlude. Motion follows scroll and has a reduced-motion path. These rules do not replace the operational-console style of web/.

**Key Characteristics:**

- Mint ground, forest ink, thin green dividers.
- Unbounded Latin signature and compact counters.
- Bold Chinese headlines with generous reading measure.
- Crisp circular SVG nodes, rings, and connecting paths.
- Citron and cobalt reserved for action and state.
- Flat tonal surfaces with no decorative shadow system.

## Colors

Botanical neutrals carry the page; citron and cobalt are scarce signals for action, memory, and motion.

### Primary

- **Forest Ink:** primary text, diagram core, header brand, and primary action.
- **Cobalt Signal:** the interlude surface and motion accent.

### Secondary

- **Citron Signal:** action surface, selected state, and node marker.

### Neutral

- **Mint Ground:** hero and header surface.
- **Cool Paper:** reading surface for story, principles, questions, and footer.
- **Muted Green:** secondary copy and captions.
- **Line Green:** one-pixel dividers and diagram tracks.

**The Signal Rarity Rule.** Citron and cobalt mark an action or state change; they are not general background decoration.

## Typography

**Display Font:** Unbounded with a sans-serif fallback.
**Body Font:** PingFang SC, Microsoft YaHei, sans-serif.
**Label/Mono Font:** the body stack for labels; monospace for installation commands.

The Latin signature is geometric and oversized. Chinese copy is bold, direct, and legible with tight display tracking and a relaxed body rhythm.

- **Display:** 700, clamp(100px, 20.7vw, 320px), 1.1, -0.04em; FULI wordmark.
- **Headline:** 750, clamp(42px, 5.3vw, 82px), 1.22, -0.035em; hero promise.
- **Title:** 700, clamp(33px, 3.55vw, 54px), 1.3, -0.025em; story statements.
- **Body:** 400, 16px, 1.9; explanatory copy, generally 34em or 70ch maximum.
- **Label:** 550, 12px, 1.7; metadata, captions, and navigation.

**The Two-Voice Rule.** Use Unbounded for Latin identity and counters; use the Chinese sans stack for Chinese communication.

## Layout

Use a full-width surface with gutter clamp(22px, 5vw, 88px). The desktop hero is a 1fr / 1.12fr grid; the story is 1.15fr / 1fr with a sticky diagram beside four narrative steps. At 1000px gaps and diagram scale reduce. At 700px the hero and story stack, the first nav link hides, and the story stage becomes compact and sticky. The install code scrolls inside its own block.

## Elevation & Depth

This is a flat tonal system: depth comes from mint, paper, ink, cobalt, citron, one-pixel rules, circles, and SVG rings. There is no shadow vocabulary. Focus uses a 3px cobalt outline with a 6px offset.

**The Flat-by-Default Rule.** Use a surface change, ring, or path instead of shadow, blur, or simulated material.

## Shapes

Buttons use 6px corners; the utility copy button uses 4px; the brand mark uses 7px. Diagram nodes, signal dots, and the Agent core are circular. SVG diagram labels may use a 24px pill radius. Dividers are one-pixel lines. Icons are inline SVG paths with 1.8px stroke, round caps, and round joins.

## Components

### Buttons

Primary and light actions use 17px 23px padding, 54px minimum height, and 6px corners. Primary is forest ink with white text; light is citron with forest ink text. Hover changes the surface; focus uses the shared cobalt outline. Text links remain unboxed and underline on hover.

### Navigation

Mint header, 82px desktop and 70px mobile, with 36px desktop link gaps and 20px mobile gaps. Links inherit forest ink, underline on hover, and keep the shared focus outline.

### Relationship Diagram

A dark Agent core, four satellite nodes, thin paths, and a ring form the sticky story. Scene state changes recolor the core and markers. Each marker uses one inline SVG icon treatment.

### Install and Disclosure

The forest install block contains a monospace command sequence and a bordered copy utility. FAQ rows use native details and summary with one-pixel dividers, a plus/minus marker, and a 70ch answer measure.

## Do's and Don'ts

### Do:

- **Do** keep this system scoped to site/; web/ has its own console language.
- **Do** use the named palette and one-pixel line vocabulary.
- **Do** explain mechanisms with authored SVG geometry and paths.
- **Do** preserve readable content when motion is reduced or JavaScript is unavailable.
- **Do** use the shared 1.8px rounded SVG icon stroke.

### Don't:

- **Don't** turn the site into a repeated feature-card grid or generic dashboard.
- **Don't** add gradients, decorative shadows, blur, or fake texture.
- **Don't** use Unicode glyphs or emoji as diagram icons.
- **Don't** present synthetic activity or private project data as public evidence.
