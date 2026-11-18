import { readFile } from 'node:fs/promises';

import { compareSemanticVersions, parseSemanticVersion } from '../src/semantic-version.js';

// The installers the stable pages link to, by version (build-site.js linkDownloads).
// (The same names for a beta: build-site.js links a preview's installers the same way.)
export const stableInstallers = version => [`FULI-Setup-${version}.exe`, `fuli-macos-arm64-${version}.dmg`];

// The stable release the website may link to: the newest GitHub release that
// is public (not a draft), not a prerelease, has a stable version no newer
// than `ceiling` (what this build would otherwise name) and carries both
// installers. A release made but still building its installers, a draft or a
// beta never replaces the last complete one (11-19: the pages linked a draft
// 0.27.17 and Windows downloads answered 404). Null when none qualifies.
export function publishedStable(releases, ceiling) {
  return newest(releases.flatMap(release => {
    const version = completeRelease(release);
    return version && release.prerelease === false && !version.includes('-')
      && compareSemanticVersions(version, ceiling) <= 0 ? [version] : [];
  }));
}

// The preview /next/ shows: the newest public prerelease (a beta) with both installers
// whose version is ahead of the stable release the site names. It need not be the one
// this build packages: after a stable release the last beta is still a valid preview
// (11-19: /next/ fell back to beta.2 while beta.8 was public). A newer draft or a beta
// missing an installer is passed over for the newest complete one; null when none is ahead.
export function publishedPreview(releases, stable) {
  return newest(releases.flatMap(release => {
    const version = completeRelease(release);
    return version && release.prerelease === true && version.includes('-')
      && compareSemanticVersions(version, stable) > 0 ? [version] : [];
  }));
}

const newest = versions => versions.sort(compareSemanticVersions).at(-1) ?? null;

// A release's version when it is public, tagged exactly v<version> (the download links are
// /releases/download/v<version>/), and carries both installers that finished uploading and
// have bytes (one still being attached, state starter and size 0, does not count).
function completeRelease(release) {
  const tag = String(release?.tag_name ?? '');
  const version = tag.startsWith('v') ? tag.slice(1) : '';
  if (release?.draft !== false || !isVersion(version) || `v${version}` !== tag) return null;
  const uploaded = new Set((release.assets ?? []).filter(asset => asset?.state === 'uploaded'
    && Number.isInteger(asset.size) && asset.size > 0).map(asset => asset.name));
  return stableInstallers(version).every(name => uploaded.has(name)) ? version : null;
}

function isVersion(text) {
  try { return Boolean(parseSemanticVersion(text)); } catch { return false; }
}

// GitHub's release list as the Pages workflow saved it (FULI_SITE_RELEASES):
// a JSON array, or one JSON release per line (gh api --paginate --jq '.[]').
export async function readReleases(path) {
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
