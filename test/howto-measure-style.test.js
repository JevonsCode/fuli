import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// 怎么用 (/howto): with the page width set to 铺满 the cards fill the window,
// but its sentences keep a reading measure (.ui-prose, --measure in ch: about
// 72 Latin characters, 36 Chinese). The phrases to copy, the cards and the
// page keep the page's width.
const read = path => readFileSync(path, 'utf8');
const tokens = read('web/src/styles/tokens.css');
const primitives = read('web/src/styles/primitives.css');
const pageStack = read('web/src/components/PageStack.vue');
const page = read('web/src/pages/HowtoPage.vue');
const move = read('web/src/features/howto/HowtoMoveCard.vue');
const story = read('web/src/features/howto/HowtoCaseCard.vue');
const heading = read('web/src/features/about/AboutSectionHeading.vue');

test('the reading measure is set in ch, between 68 and 76', () => {
  const measure = Number(/--measure:\s*(\d+)ch;/.exec(tokens)?.[1]);
  assert.ok(measure >= 68 && measure <= 76, `--measure is ${measure}ch`);
  assert.match(primitives, /\.ui-prose\s*\{[^}]*max-width:\s*var\(--measure\)/);
});

test('Chinese text gets a narrower measure on this page, still in ch (about 34 to 40 characters)', () => {
  const zh = Number(/\.howto-view:lang\(zh\) \{ --measure: (\d+)ch; \}/.exec(page)?.[1]);
  // 1ch is Inter's 0, about 0.62em; a Chinese character is 1em.
  const characters = zh * 0.62;
  assert.ok(characters >= 34 && characters <= 40, `${zh}ch holds about ${characters.toFixed(1)} Chinese characters`);
});

test('every sentence on the page carries the measure', () => {
  for (const [source, classes] of [
    [heading, ['ui-prose">{{ description }}']],
    [move, ['howto-move-when ui-prose', 'howto-move-note ui-prose']],
    [story, ['howto-case-summary ui-prose', 'howto-step-did ui-prose', 'howto-step-fuli ui-prose']]
  ]) {
    for (const name of classes) assert.ok(source.includes(name), name);
  }
  // The heading no longer caps its line in pixels, which ran past the measure at 14px.
  assert.doesNotMatch(heading, /max-width:\s*\d+px/);
});

test('the page, its cards and the phrases to copy keep the page width', () => {
  assert.match(pageStack, /:root\[data-page-width="full"\] \.page-stack \{ max-width: none; \}/);
  for (const source of [page, move, story]) assert.doesNotMatch(source, /max-width:\s*[\d.]+ch/);
  assert.doesNotMatch(/\.howto-phrase \{[^}]*\}/.exec(move)?.[0] ?? '', /max-width/);
  assert.doesNotMatch(/<code class="howto-phrase"[^>]*>/.exec(move)?.[0] ?? '', /ui-prose/);
});
