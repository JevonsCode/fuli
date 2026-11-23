// The bounds of a standing assignment's fields, shared by the store and every
// caller that checks input before it reaches the store.
export const ID_LIMIT = 200;
export const TERM_LIMIT = 80;
export const MAX_TERMS = 20;
export const RESPONSIBILITY_LIMIT = 240;
// A task entry's workKind; the project's lead hands a task to a line with
// "workstream:<the line's name>" there (task-entry-workstream.js), so a line's
// name fits in what is left.
export const WORK_KIND_LIMIT = 128;
export const HANDOFF_PREFIX = 'workstream:';
export const WORKSTREAM_NAME_LIMIT = WORK_KIND_LIMIT - HANDOFF_PREFIX.length;
// The ended assignments of a project a ledger lists, most recent first.
export const RETIRED_SHOWN = 20;
