// Names Git or the file system resolve to .git / .gitmodules, so a visit
// worktree holding one under any spelling is held before Git sees it: any
// case, an 8.3 short name (git~1, gitmod~1), trailing dots or spaces (NTFS)
// and ignorable characters (HFS+) dropped.
const IGNORABLE = /[​-‏‪-‮⁠-⁤﻿]/g;
const fileSystemName = (name) => name.replace(IGNORABLE, '').replace(/[. ]+$/, '').toLowerCase();

export const gitDirectoryName = (name) => ['.git', 'git~1'].includes(fileSystemName(name));
export const gitModulesName = (name) => fileSystemName(name) === '.gitmodules' || /^gitmod~\d+$/.test(fileSystemName(name));
