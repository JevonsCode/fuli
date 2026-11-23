import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// The pull request identity gate. This repository is public, and a commit
// carries two e-mail addresses forever: its author's and its committer's. A
// fresh clone takes the committer from the machine's global git config, so a
// commit made with only `--author` publishes whatever address that config
// holds. Every commit a pull request adds must name GitHub's no-reply
// addresses in both places.
//
// node scripts/check-commit-identity.js BASE [HEAD]
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (!base) {
    console.error('Usage: node scripts/check-commit-identity.js BASE [HEAD]');
    process.exit(2);
  }
  const log = execFileSync('git', ['log', '--format=%H%x09%ae%x09%ce', `${base}..${head}`], { encoding: 'utf8' });
  const found = commitsWithPersonalAddress(log.split('\n'));
  for (const { commit, where } of found) {
    // The address itself is not printed: CI logs of a public repository are public too.
    console.error(`${commit}: the ${where.join(' and ')} address is not a GitHub no-reply address`);
  }
  if (found.length) {
    console.error('Rewrite these commits with a GitHub no-reply address as both author and committer '
      + '(git -c user.name=NAME -c user.email=ID+LOGIN@users.noreply.github.com rebase --force-rebase BASE), then force-push.');
    process.exit(1);
  }
}
