import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { createTour } from '../site/guide-tour.js';
import { messages } from '../site/guide/translations.js';

const page = () => parseHTML(readFileSync(new URL('../site/guide/index.html', import.meta.url), 'utf8')).document;
const site = path => new URL('../site/guide/' + path, import.meta.url);

// Every tour step points at a screen that exists and has one mark: a ring on a screenshot or a
// line of the session; every mark belongs to a step, and every screen has its picture in both languages.
test('each quick-start tour step has its screen and one mark, and every screen exists in both languages', () => {
  const document = page();
  const tours = [...document.querySelectorAll('[data-tour]')];
  assert.deepEqual(tours.map(tour => tour.closest('section').id), ['connect', 'use', 'console', 'model']);
  for (const tour of tours) {
    const steps = [...tour.querySelectorAll('.tour-steps > li')];
    const frames = new Set([...tour.querySelectorAll('.app-frame')].map(frame => frame.dataset.frame));
    const marks = [...tour.querySelectorAll('[data-step]')].map(mark => Number(mark.dataset.step));
    steps.forEach((step, i) => {
      assert.ok(frames.has(step.dataset.frame), `${tour.closest('section').id} step ${i + 1} has its screen`);
      assert.ok(marks.includes(i), `${tour.closest('section').id} step ${i + 1} has a mark`);
      assert.equal(step.querySelector('.tour-n').textContent, String(i + 1));
    });
    assert.ok(marks.every(mark => mark < steps.length));
    assert.equal(tour.querySelectorAll('.app-frame.is-current').length, 1, 'the first screen shows before the script runs');
    for (const spot of tour.querySelectorAll('.tour-spot')) assert.equal(spot.querySelector('b').textContent, String(Number(spot.dataset.step) + 1));
  }
  for (const image of document.querySelectorAll('img[src]')) {
    const path = image.getAttribute('src');
    if (path.includes('/avatars/')) continue; // drawn at build time (scripts/site-avatars.js)
    assert.ok(existsSync(site(path)), path);
  }
  for (const frame of document.querySelectorAll('.app-frame:not(.tour-terminal)')) {
    assert.equal(frame.querySelectorAll('img.screen-zh').length, 1);
    assert.equal(frame.querySelectorAll('img.screen-en').length, 1);
  }
  for (const name of ['astro', 'jefa', 'bole', 'tonborg']) assert.ok(document.querySelector(`.fla-row img[src="../assets/avatars/${name}.webp"]`), name);
});

// Visible copy stays short: one point per line, at most 100 characters in either language.
test('the quick start says each visible point in at most 100 characters in both languages', () => {
  for (const [locale, copy] of Object.entries(messages)) {
    for (const [key, value] of Object.entries(copy)) {
      if (key.startsWith('meta.') || key.endsWith('Url')) continue;
      assert.ok(value.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').length <= 100, `${locale} ${key}`);
    }
  }
});

test('a tour shows one step at a time: its screen, its mark and the session lines up to it, then moves on when its bar ends', () => {
  const document = page();
  const root = document.querySelector('#use [data-tour]');
  const tour = createTour(root);
  const current = selector => [...root.querySelectorAll(selector)].filter(node => node.classList.contains('is-current'));
  assert.ok(root.classList.contains('is-enhanced') && root.classList.contains('is-autoplay'));
  assert.equal(tour.current, 0);
  assert.deepEqual(current('.app-frame').map(frame => frame.dataset.frame), ['0']);
  assert.ok(root.querySelector('[data-step="1"]').classList.contains('is-ahead'), 'a later line of the session waits');

  root.querySelector('.tour-steps li:nth-child(4) button').dispatchEvent(new document.defaultView.Event('click'));
  assert.equal(tour.current, 3);
  assert.deepEqual(current('.app-frame').map(frame => frame.dataset.frame), ['1']);
  assert.deepEqual(current('.tour-spot').map(spot => spot.dataset.step), ['3']);
  assert.equal(root.querySelector('.tour-steps li:nth-child(4) button').getAttribute('aria-current'), 'step');
  assert.equal(root.querySelectorAll('[aria-current]').length, 1);
  assert.equal(root.querySelectorAll('.is-ahead').length, 0, 'every session line stays once the tour has moved past it');

  const bar = root.querySelector('.tour-steps li:nth-child(4) .tour-bar');
  bar.dispatchEvent(new document.defaultView.Event('animationend', { bubbles: true }));
  assert.equal(tour.current, 4);
  tour.show(5);
  root.querySelector('.tour-steps li:nth-child(6) .tour-bar').dispatchEvent(new document.defaultView.Event('animationend', { bubbles: true }));
  assert.equal(tour.current, 0, 'after the last step the tour starts again');

  // The caption on the screen repeats the current step's words under the same i18n key, hidden from screen readers.
  const caption = root.querySelector('.tour-caption');
  assert.equal(caption.getAttribute('aria-hidden'), 'true');
  assert.deepEqual([...caption.querySelectorAll('[data-i18n]')].map(node => node.getAttribute('data-i18n')),
    [...root.querySelectorAll('.tour-steps [data-i18n]')].map(node => node.getAttribute('data-i18n')));
  assert.deepEqual([...caption.querySelectorAll('.is-current [data-i18n]')].map(node => node.getAttribute('data-i18n')), ['guide.use.ask']);

  tour.setPlaying(true);
  assert.ok(root.classList.contains('is-playing'));
  const still = createTour(document.querySelector('#model [data-tour]'), { autoplay: false });
  still.setPlaying(true);
  assert.ok(!document.querySelector('#model [data-tour]').classList.contains('is-playing'), 'reduced motion never plays');
});
