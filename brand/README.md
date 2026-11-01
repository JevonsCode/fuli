# Brand

The FULI brand (Brand & Motion Guidelines v1.1) has its one source here. Everything else in the
repository that shows the brand is a generated copy; change the brand here, never in a copy.

- Figma master file, where the brand evolves: <https://www.figma.com/design/mbP73Ul4mif5FsS2Fxws9U>
- Figma Community page, public to view and duplicate: <https://www.figma.com/community/file/1698659778015746085>

## What is here

The files keep the design delivery's names and folders, so an updated delivery copies over them.

| Path | What it is | Used by |
| --- | --- | --- |
| `svg/mark/fuli-mark-color.svg`, `fuli-mark-dark.svg` | The master mark for light and dark surfaces | console and site images; the mark data |
| `svg/mark/fuli-mark-micro-color.svg`, `fuli-mark-micro-dark.svg` | The micro cut: a larger ring and wider channels for 16-24 px | tray icons, the console's inline loading; the mark data |
| `svg/wordmark/fuli-wordmark-{en,zh}{,-dark}.svg` | The FULI and 复利 wordmarks | console and desktop client top bars (the dark ones wait for a dark theme) |
| `svg/lockup/fuli-lockup-bilingual-horizontal{,-dark}.svg` | Mark with 复利 FULI | the repository READMEs |
| `png/mark/favicon.ico` | The favicon, micro cut at 16 and 24 px | console and site |
| `png/mark/fuli-mark-color-512.png` | The mark as a raster | the site's link previews |
| `png/app-icon/fuli-app.ico`, `fuli-app-icon-light-{512,1024}.png` | The light app icon (white rounded square) | Windows, macOS and notification icons |
| `motion/fuli-motion.css` | The mark's motion: loading, entrance, resonance, ambient, and the reduced-motion fallback | the console's loading |

**Optical sizing.** Draw the master mark from 28 px up and the micro cut below 28 px (favicons, tray
icons, 16 px loading). The minimum is 16 px.

**Backdrop.** Wherever the mark sits on a backdrop (the app icon, the tray icons, a logo plate in the
console or on the site), the backdrop is a rounded square with corners about 22.5 % of its side, like
the app icon; never a disc.

**Logo palette.** Ink `#18181B`, white `#FFFFFF` and the black-gold gradient belong to the mark, the
wordmarks, the lockups and the app icon only. They are not interface colours; the console's UI tokens
do not use them.

## Changing the brand

1. Change it in the Figma master file and export the delivery.
2. Copy the changed files over the ones here, keeping their names and folders.
3. From the repository root, run:

   ```
   node scripts/build-brand-assets.js
   ```

4. Commit `brand/` together with the regenerated copies. `test/brand-assets.test.js` fails while any copy
   no longer matches its source here.

## What gets generated where

`scripts/build-brand-assets.js` writes, at the paths each client already loads:

- **Console** (`web/`, read only through `web/src/lib/brand.ts`):
  `web/assets/brand/fuli-mark-color.svg`, `fuli-wordmark-{en,zh}.svg`, `fuli-motion.css`, `fuli-mark.json`;
  `web/public/favicon.ico` (also served at `/favicon.ico`).
- **Site** (`site/`): `site/assets/brand/fuli-mark-color.svg`, `fuli-mark-dark.svg`, `favicon.ico`,
  `fuli-mark-color-512.png`.
- **Mark data**, read from `svg/mark/`, for clients that draw the mark themselves:
  - `desktop/flutter/assets/brand/fuli-mark.json`, the desktop client's contract: `master` and `micro`,
    each with `orbitGold`, `orbitUpper`, `wave` and `bars[3]` as SVG path data on the 512 view box;
    `gold.light` and `gold.dark` stops as `[offset, colour]`; `ink` and `white`. Its keys and layout
    are fixed; the client's tests read the same shape.
  - `web/assets/brand/fuli-mark.json`, the console's: the same, plus `viewBox`, `goldLine` (the
    gradient's line) and `microBelowPx` (28).
- **Wordmark data**, read from `svg/wordmark/fuli-wordmark-{zh,en}.svg`:
  `desktop/flutter/assets/brand/fuli-wordmark.json`, the desktop client's top line: `zh` (复利) and
  `en` (FULI), each with `viewBox` (`[x, y, width, height]` in the paths' own coordinates, the
  group's translate folded in, the clear space kept) and `paths` (SVG path data). The client draws
  them in the mark's `ink`; a wordmark in another fill or with a transform other than a translate
  is refused.
- **Desktop client** (`desktop/flutter/`):
  - `assets/tray/{ok,needs_person,broken}.{png,ico}`: the mark on a white rounded square (the app icon's corners) with a green, amber or
    red status dot, drawn from the SVG marks (the micro cut where the mark is under 28 px);
  - `windows/runner/resources/app_icon.ico`: `png/app-icon/fuli-app.ico` as it is;
  - `assets/app/fuli.png`: the app icon's 256 px entry, for Windows notifications;
  - `macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_*.png`: the smallest ready app icon at
    least that size, inside the transparent margin macOS expects.
