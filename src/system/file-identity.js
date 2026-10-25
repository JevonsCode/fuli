// A file's exact identity, `dev:ino`, from a stat read with { bigint: true }
// (rec#49). Windows file IDs exceed 2^53, so two different files can share an
// ID once it is rounded to a Number. A Number stat is refused rather than
// rounded, so a caller that forgot { bigint: true } fails closed instead of
// taking two files for one.
export function fileIdentity(stat) {
  if (typeof stat?.dev !== 'bigint' || typeof stat?.ino !== 'bigint') {
    throw new TypeError('File identity needs a stat read with { bigint: true }');
  }
  return `${stat.dev}:${stat.ino}`;
}
