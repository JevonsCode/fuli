# Brand

`fuli-logo.png` is the one source of the FULI logo (512 x 512, transparent RGBA PNG). To change the
logo, replace this file and run from the repository root:

```
node scripts/build-brand-assets.js
```

It regenerates, at the paths the console, the site and the desktop client already load:

- copies: `web/assets/brand/fuli-logo.png` (console, imported through `web/src/lib/brand.ts`; also its
  favicon), `site/assets/fuli-logo.png` and `site/v0/assets/fuli-logo.png`;
- `desktop/flutter/assets/tray/{ok,needs_person,broken}.{png,ico}`: the logo on a light disc with a
  green, amber or red status dot;
- `desktop/flutter/assets/app/fuli.png`, `desktop/flutter/windows/runner/resources/app_icon.ico` and
  `desktop/flutter/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_*.png`: the logo on a
  light rounded square.

`test/brand-assets.test.js` fails while any of them no longer matches this file.
