import { InvalidInputError } from '../app/application-error.js';
import { FULI_VERSION } from '../package-metadata.js';
import { compareSemanticVersions } from '../semantic-version.js';
import { dismissedNpmNotices, npmCopyDataSeen, setNpmNoticeDismissed } from './npm-adoption.js';
import { findNpmCopies } from './npm-copies.js';
import { uninstallNpmCopy } from './npm-copy-uninstall.js';

// What the desktop app's console offers about the npm copies beside it: the
// list (with whether the person closed its notice, the other data its
// clients use when the app left it alone for that, and whether it is newer
// than the app), removing one on the
// person's click or words, and closing or reopening its notice. Only a copy
// found on this machine right now can be removed; a path from a request is
// never trusted on its own.
export function createNpmCopyControl({ dataDir, ownRoot, find = () => findNpmCopies({ ownRoot }),
  uninstall = uninstallNpmCopy, appVersion = FULI_VERSION }) {
  let removing = false;

  function list() {
    const dismissed = dismissedNpmNotices(dataDir);
    const seen = npmCopyDataSeen(dataDir);
    return { copies: find().map(({ packageRoot, version, shellCommands, removeCommand }) => ({
      packageRoot, version, shellCommands, removeCommand, noticeDismissed: dismissed.has(packageRoot),
      otherDataDir: seen[packageRoot]?.shares === false && typeof seen[packageRoot].dataDir === 'string' ? seen[packageRoot].dataDir : null,
      newer: compareSemanticVersions(version, appVersion) > 0 })) };
  }

  const foundCopy = (input) => {
    const copy = find().find(({ packageRoot }) => packageRoot === input?.packageRoot);
    if (!copy) throw new InvalidInputError('No npm copy of FULI is installed there.');
    return copy;
  };

  return {
    list,
    async uninstall(input) {
      onlyKeys(input, ['packageRoot']);
      const copy = foundCopy(input);
      if (removing) throw new InvalidInputError('An npm copy of FULI is already being removed.');
      removing = true;
      try { return await uninstall(copy); } finally { removing = false; }
    },
    setNotice(input) {
      onlyKeys(input, ['packageRoot', 'dismissed']);
      if (typeof input.dismissed !== 'boolean') throw new InvalidInputError('dismissed must be true or false.');
      setNpmNoticeDismissed(dataDir, foundCopy(input).packageRoot, input.dismissed);
      return list();
    }
  };
}

function onlyKeys(input, keys) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new InvalidInputError(`Send only ${keys.join(' and ')}.`);
  }
}
