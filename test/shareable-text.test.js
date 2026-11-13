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

test('URL userinfo runs to the last @ before the host', () => {
  assert.equal(shareableText('https://user:p@ss@host.invalid/x'), 'https://host.invalid/x');
  assert.equal(shareableText('https://user:pa:ss@host.invalid/x?y=1'), 'https://host.invalid/x?y=…');
  assert.equal(shareableText('mail a@b.invalid'), 'mail a@b.invalid');
});
