import { mkdir, writeFile } from 'node:fs/promises';
import { createAvatar } from '../web/src/vendor/fuli-avatar/avatar.js';

// The website's FLA portraits, drawn at build time by the renderer the console ships
// (web/src/vendor/fuli-avatar, fuli-avatar 0.5.0) from fixed seeds, so the site shows the same
// kind of FLA the client does without loading the renderer in the page. Still images: the site
// moves them with CSS, and reduced motion keeps them still.
export const SITE_AVATAR_COUNT = 28;

export async function writeSiteAvatars(directory) {
  await mkdir(directory, { recursive: true });
  for (let n = 1; n <= SITE_AVATAR_COUNT; n++) {
    await writeFile(new URL(`fla-${n}.svg`, directory), createAvatar(`site-fla-${n}`, { animate: false, eggs: false, size: 128 }));
  }
}
