import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createAvatar } from '../web/src/vendor/fuli-avatar/avatar.js';

// The website's FLA portraits, drawn at build time by the renderer the console ships
// (web/src/vendor/fuli-avatar, fuli-avatar 0.5.0) from fixed seeds, so the site shows the same
// kind of FLA the client does without loading the renderer in the page. Still images: the site
// moves them with CSS, and reduced motion keeps them still.
export const SITE_AVATAR_COUNT = 48;

// The four built-in FLAs wear the console's own portraits (web/src/assets/*-avatar.webp), in the one
// small 192 px export the READMEs also show (docs/readme/fla-*.webp), so every page uses the same copy.
export const BUILT_IN_FLAS = ['astro', 'jefa', 'bole', 'tonborg'];

export async function writeSiteAvatars(directory) {
  await mkdir(directory, { recursive: true });
  for (let n = 1; n <= SITE_AVATAR_COUNT; n++) {
    await writeFile(new URL(`fla-${n}.svg`, directory), createAvatar(`site-fla-${n}`, { animate: false, eggs: false, size: 128 }));
  }
  for (const name of BUILT_IN_FLAS) {
    await copyFile(new URL(`../docs/readme/fla-${name}.webp`, import.meta.url), new URL(`${name}.webp`, directory));
  }
}
