import { join } from 'node:path';

import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions, parseSemanticVersion } from '../semantic-version.js';
import { jsonFormat, readJsonRecord, writeVersionedJsonFileAtomic } from '../storage/json-format.js';
import { RELEASE_LINES_DIR, readReleaseLines, releasePageUrl, shippedLineVersions } from './release-lines.js';

// After FULI updates, the console says once what is new in the installed
// version (Jevons 11-08). This record keeps the last version whose notice was
// shown, on this computer. A new installation starts with its own version
// already seen (setup/first-run-capture.js), so it never hears about a version
// it never left; an installation from before this record has none and hears
// about the version it updated to. When versions were skipped, only the
// installed version's lines are shown, with how many releases came between.
export const WHATS_NEW_FILE = 'whats-new.json';
export const WHATS_NEW_FORMAT = jsonFormat({ store: 'whats-new', versions: [1] });
export const RELEASES_URL = 'https://github.com/JevonsCode/fuli/releases';

export function createWhatsNew({ dataDir, version = FULI_VERSION, linesDir = RELEASE_LINES_DIR,
  now = () => new Date().toISOString() }) {
  const path = join(dataDir, WHATS_NEW_FILE);
  const seenVersion = () => {
    const record = readJsonRecord(path, WHATS_NEW_FORMAT);
    return typeof record?.seenVersion === 'string' ? record.seenVersion : null;
  };
  const markSeen = () => writeVersionedJsonFileAtomic(path, { version: 1, seenVersion: version, seenAt: now() }, WHATS_NEW_FORMAT);

  // Releases with lines between the last seen version and this one. A stable
  // version does not count the previews that led to it.
  const skippedSince = (seen) => shippedLineVersions({ dir: linesDir }).filter((candidate) =>
    compareSafely(candidate, seen) > 0 && compareSemanticVersions(candidate, version) < 0
      && (isPrerelease(version) || !isPrerelease(candidate))).length;

  // The installed version's lines for any reader (the console, an Agent), and
  // the notice the console shows when this version is new to the person.
  const status = () => {
    const lines = readReleaseLines(version, { dir: linesDir });
    const seen = seenVersion();
    const fresh = lines !== null && (seen === null || compareSafely(seen, version) < 0);
    return {
      version,
      lines: lines ? { zh: lines.zh, en: lines.en } : null,
      releaseUrl: releasePageUrl(version),
      notice: fresh ? { skipped: seen === null ? 0 : skippedSince(seen), releasesUrl: RELEASES_URL } : null,
    };
  };

  return Object.freeze({
    // A new installation: nothing is new to the person yet.
    beginInstallation() {
      if (seenVersion() === null) markSeen();
    },
    status,
    // The console showed the notice; it is not shown again for this version.
    markSeen(input) {
      if (input?.version !== version) {
        throw Object.assign(new TypeError(`Only the installed version ${version} can be marked seen`), { code: 'not_installed_version' });
      }
      markSeen();
      return status();
    },
  });
}

const isPrerelease = (version) => parseSemanticVersion(version).prerelease.length > 0;

// A seen version that does not parse counts as older, so the notice still shows once.
function compareSafely(left, right) {
  try { return compareSemanticVersions(left, right); } catch { return -1; }
}
