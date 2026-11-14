import assert from 'node:assert/strict';
import test from 'node:test';

import { shareableText } from '../src/text/shareable-text.js';

// Synthetic paths and prose only.
test('a diagnostic keeps its routes and the prose after a path', () => {
  const keepRoutes = text => shareableText(text, { mode: 'keep-routes' });
  assert.equal(keepRoutes('see /api/tasks for details'), 'see /api/tasks for details');
  assert.equal(keepRoutes('POST /api/synthetic failed'), 'POST /api/synthetic failed');
  assert.equal(keepRoutes('read /home/alice/notes for details'), 'read [path] for details');
  assert.equal(keepRoutes('open C:\\Users\\Alice\\file.txt then retry'), 'open [path] then retry');
});

test('a visitor\'s text follows spaces in a path\'s last segment and keeps the prose after it', () => {
  assert.equal(shareableText('C:\\Users\\Alice\\Private Repo'), '[path]');
  assert.equal(shareableText('at /home/alice/my folder/file.txt today'), 'at [path] today');
  assert.equal(shareableText('see /opt/app for details.'), 'see [path] for details.');
  assert.equal(shareableText('clone into ~/code then run it'), 'clone into [path] then run it');
  assert.equal(shareableText('see /api/tasks for details'), 'see [path] for details');
});

test('a visitor\'s text names no part of a local path, in any form, and keeps the prose and relative paths around it', () => {
  const backtick = '`';
  const shown = {
    // An unquoted path's last segment with spaces and no extension: capitalised words and numbers follow it.
    'Stored in /home/synthetic/Secret Confidential Folder': 'Stored in [path]',
    'Stored in /home/synthetic/Secret\tConfidential Folder 2': 'Stored in [path]',
    'Stored in ~/Secret Confidential Folder': 'Stored in [path]',
    'Stored in ~\\Secret Folder, then': 'Stored in [path], then',
    // Inside quotes or backticks a path runs to the closing mark.
    'Stored in "/home/synthetic/secret plans" now': 'Stored in "[path]" now',
    'Stored in \'/home/synthetic/secret plans\' now': 'Stored in \'[path]\' now',
    [`Stored in ${backtick}~/secret plans${backtick} now`]: `Stored in ${backtick}[path]${backtick} now`,
    [`Stored in ${backtick}C:\\Users\\Synthetic\\Secret Folder${backtick} now`]: `Stored in ${backtick}[path]${backtick} now`,
    [`Stored in ${backtick}\\\\fileserver\\share\\Secret Folder${backtick} now`]: `Stored in ${backtick}[path]${backtick} now`,
    // Drive and UNC paths run to the end of their line or quoted string.
    'Stored in C:\\Users\\Synthetic\\Secret Folder': 'Stored in [path]',
    'Stored in C:/Users/Synthetic/Secret Folder': 'Stored in [path]',
    'Stored in "C:\\Users\\Synthetic\\Secret Folder" now': 'Stored in "[path]" now',
    'Stored in \\\\fileserver\\share\\Secret Folder': 'Stored in [path]',
    'Stored in file:///home/synthetic/Secret%20Folder now': 'Stored in [path] now',
    // Closing punctuation after a path stays.
    'Stored in /home/synthetic/notes.md, then read': 'Stored in [path], then read',
    'Stored in (/home/synthetic/notes.md), then': 'Stored in ([path]), then',
    [`Stored in ${backtick}/home/synthetic/notes.md${backtick}.`]: `Stored in ${backtick}[path]${backtick}.`,
    'see /opt/app. Then restart it': 'see [path]. Then restart it',
    // A file: URL follows the same capitalised tail.
    'file:///home/alice/Secret Plans ok': '[path] ok',
    // Capitalised words continue only a path whose last segment is capitalised.
    'POST /api/tasks Then OK': 'POST [path] Then OK',
    'I use /usr/bin I think': 'I use [path] I think',
    'See /docs/Guide For Setup': 'See [path]',
    // Known limit: a bracketed aside after a path stays.
    'Stored in /home/synthetic/notes (Secret Plans)': 'Stored in [path] (Secret Plans)',
    // Lower-case prose after a path and repository-relative paths stay.
    'Deploys from /srv/synthetic/app on port 4100': 'Deploys from [path] on port 4100',
    'see src/text/local-paths.js and docs/guide.md for details': 'see src/text/local-paths.js and docs/guide.md for details',
    'and/or either/or, 1/2 of it, km/h': 'and/or either/or, 1/2 of it, km/h'
  };
  for (const [text, expected] of Object.entries(shown)) assert.equal(shareableText(text), expected, text);
});

// Runs of punctuation, separators, quotes and capitalised words: each shape
// once small (exact output) and once at about 100 KB (linear time).
test('path redaction stays linear on long adversarial input', () => {
  const shapes = [
    [count => `/a${'!'.repeat(count)}x`, '[path]'],
    [count => `/A${'.'.repeat(count)} B`, '[path]... B'],
    [count => '/'.repeat(count), '///'],
    [count => './'.repeat(count), '[path]'],
    [count => '"/a '.repeat(count), '"[path]"[path]"[path] '],
    [count => '\'/A B '.repeat(count), '\'[path]\'[path]\'[path] '],
    [count => `/A${' B'.repeat(count)}`, '[path]'],
    [count => '/A B! '.repeat(count), '[path]! '],
    [count => '/Ab "x" !!! .. ~/ Q 1 '.repeat(count), '[path] "x" !!! .. [path] "x" !!! .. [path] "x" !!! .. [path] Q 1 ']
  ];
  for (const [shape, expected] of shapes) {
    const sample = shape(3);
    assert.equal(shareableText(sample), expected, sample);
    for (const mode of ['strict', 'keep-routes']) {
      const text = shape(Math.ceil(100_000 / sample.length * 3));
      const started = performance.now();
      shareableText(text, { mode });
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 500, `${JSON.stringify(sample)} ${mode} took ${Math.round(elapsed)} ms`);
    }
  }
});

test('URL userinfo runs to the last @ before the host', () => {
  assert.equal(shareableText('https://user:p@ss@host.invalid/x'), 'https://host.invalid/x');
  assert.equal(shareableText('https://user:pa:ss@host.invalid/x?y=1'), 'https://host.invalid/x?y=…');
  assert.equal(shareableText('mail a@b.invalid'), 'mail a@b.invalid');
});
