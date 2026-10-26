// A test that runs a child process stops it if it never exits, so a hang cannot
// stall the suite. This is a hang guard only, never the deadline under test:
// starting a Node process takes seconds on a loaded machine (the full suite,
// CI), so it must stay far above that.
export const CHILD_HANG_GUARD_MS = 60_000;
