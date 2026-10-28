import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { generate, OUTPUT } from '../scripts/generate-flutter-tokens.js';

test('the desktop client tokens match the console theme', () => {
  assert.equal(readFileSync(OUTPUT, 'utf8'), generate(),
    'web/src/styles/theme changed: run `node scripts/generate-flutter-tokens.js`');
});

test('tokens carry the console colours, scales and shadows', () => {
  const dart = generate({
    base: ':root {\n  --text-body: 14px;\n  --weight-medium: 500;\n  --leading-prose: 1.6;\n  --space-4: 16px;\n'
      + '  --control-height: 36px;\n  --radius-card: 12px;\n  --shadow-md: 0 6px 20px rgb(var(--shadow-rgb) / 7%);\n'
      + '  --motion-fast: 140ms;\n  --motion-ease: cubic-bezier(.2, .8, .2, 1);\n}',
    semantic: ':root {\n  --color-accent: #0f6b55; /* brand */\n  --color-overlay: rgb(24 28 26 / 32%);\n'
      + '  --color-focus: var(--color-accent);\n  --shadow-rgb: 27 31 29;\n}\n@media all { :root[data-theme="dark"] { --color-accent: #2fb38f; } }',
  });
  assert.match(dart, /static const accent = Color\(0xFF0F6B55\);/);
  assert.match(dart, /static const overlay = Color\(0x52181C1A\);/);
  assert.doesNotMatch(dart, /focus|2FB38F/i, 'no var() aliases and no dark values');
  assert.match(dart, /static const body = 14\.0;/);
  assert.match(dart, /static const weightMedium = FontWeight\.w500;/);
  assert.match(dart, /static const radiusCard = 12\.0;/);
  assert.match(dart, /BoxShadow\(color: Color\(0x121B1F1D\), offset: Offset\(0\.0, 6\.0\), blurRadius: 20\.0\)/);
  assert.match(dart, /static const ease = Cubic\(0\.2, 0\.8, 0\.2, 1\.0\);/);
});
