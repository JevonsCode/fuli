import { mkdirSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

import { execute } from '../local-runtime/windows-process-handle.js';

// Who can open FULI's data directory on Windows (rec#53 D-65). The default
// %LOCALAPPDATA%\Fuli inherits AppData\Local's ACL, which can let sandboxes
// (CodexSandboxUsers, AppContainer capabilities) and other accounts read the
// human-review token and every store. macOS and Linux keep 0700/0600 instead,
// so outside Windows this reports nothing and changes nothing.
//
// The ACL is read as SDDL (`icacls /save`), never from icacls' printed names:
// those are localized ("NT AUTHORITY\SYSTEM" is "NT-AUTORITÄT\SYSTEM" in
// German) and in the console's OEM code page, while SDDL names every
// principal by SID or a fixed alias and needs no PowerShell start per read.
// Every allow ACE counts, inherited or explicit, inherit-only included: it
// opens what the directory holds. The tools run from System32 so a PATH entry
// (Git's coreutils `whoami`) never answers instead.

const SYSTEM_SID = 'S-1-5-18';
// SDDL names SYSTEM by its alias; other aliases (BA, BU, WD…) stay as written.
const SID_ALIASES = Object.freeze({ SY: SYSTEM_SID });
// Access-allowed ACE types: plain, object, callback and callback object.
const ALLOW_TYPES = new Set(['A', 'OA', 'XA', 'ZA']);
// A large store resets file by file; icacls is given time to walk it.
const RESTRICT_TIMEOUT_MS = 10 * 60_000;
const FULL_CONTROL_INHERITED = '(OI)(CI)F';

export function windowsDataAcl({ platform = process.platform, run = execute,
  systemRoot = process.env.SystemRoot ?? 'C:\\Windows', tempRoot = tmpdir() } = {}) {
  if (platform !== 'win32') return { sharedWith: async () => [], restrictToOwner: async () => {} };
  const tool = (name) => win32.join(systemRoot, 'System32', name);

  async function currentUserSid() {
    const { stdout } = await run(tool('whoami.exe'), ['/user', '/fo', 'csv', '/nh']);
    const sid = stdout.trim().match(/"(S-1-[\d-]+)"$/)?.[1];
    if (!sid) throw new Error('whoami did not name the current user\'s SID.');
    return sid;
  }

  async function daclOf(directory) {
    const scratch = await mkdtemp(join(tempRoot, 'fuli-acl-'));
    try {
      const saved = join(scratch, 'acl');
      await run(tool('icacls.exe'), [directory, '/save', saved]);
      return allowedPrincipals((await readFile(saved)).toString('utf16le'));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }

  // The principals other than the current user and SYSTEM the ACL lets in.
  // SDDL writes the machine's built-in Administrator account (RID 500) as LA,
  // so when that is who runs FULI, LA is the current user too.
  async function sharedWith(directory) {
    const [user, principals] = await Promise.all([currentUserSid(), daclOf(directory)]);
    const self = new Set([user, SYSTEM_SID, ...(user.endsWith('-500') ? ['LA'] : [])]);
    return [...new Set(principals.filter((sid) => !self.has(sid)))];
  }

  // First every entry under the directory goes back to plain inheritance (no
  // explicit grant survives), then the directory stops inheriting and grants
  // full control to the current user and SYSTEM only, which its files and
  // folders inherit. A file the reset could not reach (/C goes on) is still
  // reported after the directory itself is protected.
  async function restrictToOwner(directory) {
    const user = await currentUserSid();
    const icacls = tool('icacls.exe');
    const resetFailure = await run(icacls, [directory, '/reset', '/T', '/C', '/Q'], { timeout: RESTRICT_TIMEOUT_MS })
      .then(() => null, (error) => error);
    await run(icacls, [directory, '/inheritance:r', '/grant:r', `*${user}:${FULL_CONTROL_INHERITED}`,
      `*${SYSTEM_SID}:${FULL_CONTROL_INHERITED}`, '/C', '/Q'], { timeout: RESTRICT_TIMEOUT_MS });
    if (resetFailure) throw resetFailure;
    // The SIDs (never names or paths) say who is left, so a report can be acted on.
    const left = await sharedWith(directory);
    if (left.length) throw new Error(`Other accounts can still open the data directory: ${left.join(', ')}.`);
  }

  return { sharedWith, restrictToOwner };
}

// `fuli setup`'s step: the data directory exists, and on Windows only its
// owner and SYSTEM can open it. An installation from before this is limited
// here too, since every update and the desktop client's first start run setup.
// Returns false when the ACL could not be read or limited; setup goes on.
export async function keepDataDirectoryPrivate(dataDir, acl = windowsDataAcl()) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    if ((await acl.sharedWith(dataDir)).length) await acl.restrictToOwner(dataDir);
    return true;
  } catch { return false; }
}

// The SIDs (or SDDL aliases) of the allow ACEs in an `icacls /save` record:
// its name line, then the SDDL. A null DACL lets everyone in. The rest of the
// line is scanned whole: a conditional ACE nests parentheses, and an SACL
// that follows holds no allow ACE.
function allowedPrincipals(saved) {
  const dacl = saved.replace(/^\uFEFF/, '').split(/\r?\n/)[1]?.match(/D:([A-Z_]*)(.*)/);
  if (!dacl) throw new Error('icacls did not save a DACL.');
  if (dacl[1].includes('NO_ACCESS_CONTROL')) return ['WD'];
  return [...dacl[2].matchAll(/\(([A-Z]+);[^;]*;[^;]*;[^;]*;[^;]*;([^;)]+)/g)]
    .filter(([, type]) => ALLOW_TYPES.has(type))
    .map(([, , sid]) => SID_ALIASES[sid] ?? sid);
}
