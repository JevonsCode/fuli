import { readFile } from 'node:fs/promises';

import { compareSemanticVersions, parseSemanticVersion } from '../src/semantic-version.js';

// The installers the stable pages link to, by version (build-site.js linkDownloads).
export const stableInstallers = version => [`FULI-Setup-${version}.exe`, `fuli-macos-arm64-${version}.dmg`];

// The stable release the website may link to: the newest GitHub release that
// is public (not a draft), not a prerelease, has a stable version no newer
// than `ceiling` (what this build would otherwise name) and carries both
// installers. A release made but still building its installers, a draft or a
// beta never replaces the last complete one (11-19: the pages linked a draft
// 0.27.17 and Windows downloads answered 404). Null when none qualifies.
export function publishedStable(releases, ceiling) {
  const candidates = releases.flatMap(release => {
    const version = String(release?.tag_name ?? '').replace(/^v/, '');
    if (release?.draft || release?.prerelease || version.includes('-') || !parseSemanticVersion(version)) return [];
    if (compareSemanticVersions(version, ceiling) > 0) return [];
    const assets = new Set((release.assets ?? []).map(asset => (typeof asset === 'string' ? asset : asset?.name)));
    return stableInstallers(version).every(name => assets.has(name)) ? [version] : [];
  });
  return candidates.sort(compareSemanticVersions).at(-1) ?? null;
}

// GitHub's release list as the Pages workflow saved it (FULI_SITE_RELEASES):
// a JSON array, or one JSON release per line (gh api --paginate --jq '.[]').
export async function readReleases(path) {
  const text = (await readFile(path, 'utf8')).trim();
  if (!text) return [];
  if (text.startsWith('[')) return JSON.parse(text);
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}
