import { execFileSync } from 'node:child_process';

import { isMainModule } from '../src/system/main-module.js';

// The pull request identity gate. This repository is public, and a commit
// carries two e-mail addresses forever: its author's and its committer's. A
// fresh clone takes the committer from the machine's global git config, so a
// commit made with only `--author` publishes whatever address that config
// holds. Every commit a pull request adds must name GitHub's no-reply
// addresses in both places.
//
// A commit already on a published branch cannot be rewritten, so only the
// commits the pull request itself adds are checked: those reachable from HEAD
// and from none of the PUBLISHED refs (its base branch, and main for a release
// branch that merged main in).
//
// node scripts/check-commit-identity.js HEAD PUBLISHED...
//   Exit 1 and list the commits when one carries any other address.

const NO_REPLY = /^(?:[^@\s]+@users\.noreply\.github\.com|noreply@github\.com)$/i;

// lines: `git log --format=%H%x09%ae%x09%ce`. Returns the commits whose author
// or committer address is not a GitHub no-reply address, naming which.
export function commitsWithPersonalAddress(lines) {
  return lines.filter(Boolean).flatMap(line => {
    const [commit, author, committer] = line.split('\t');
    const where = [NO_REPLY.test(author) ? null : 'author', NO_REPLY.test(committer) ? null : 'committer'].filter(Boolean);
    return where.length ? [{ commit, where }] : [];
  });
}

// The log holds the addresses, and a failing git would put what it had read into
// an uncaught error: CI logs of a public repository are public too, so only
// git's own message is ever printed.
function addedCommits(head, published) {
  try {
    return execFileSync('git', ['log', '--format=%H%x09%ae%x09%ce', head, '--not', ...published],
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n');
  } catch (error) {
    console.error(`git log failed: ${String(error.stderr ?? '').trim() || error.code || 'unknown error'}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  const [head, ...published] = process.argv.slice(2);
  if (!head || !published.length) {
    console.error('Usage: node scripts/check-commit-identity.js HEAD PUBLISHED...');
    process.exit(2);
  }
  const found = commitsWithPersonalAddress(addedCommits(head, published));
  for (const { commit, where } of found) {
    console.error(`${commit}: the ${where.join(' and ')} address is not a GitHub no-reply address`);
  }
  if (found.length) {
    console.error('Rewrite these commits with a GitHub no-reply address as both author and committer '
      + '(git -c user.name=NAME -c user.email=ID+LOGIN@users.noreply.github.com rebase --force-rebase BASE), then force-push.');
    process.exit(1);
  }
}
