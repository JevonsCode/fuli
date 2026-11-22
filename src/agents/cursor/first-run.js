// Cursor's CLI asks two questions the first time it runs in a project folder:
// whether to trust the folder, and whether to approve each MCP server. Started
// by something that cannot answer them — a background process, another Agent —
// it waits with no output at all, which reads as a session that started and
// then did nothing (rec#145).
//
// Checked against the installed CLI and Cursor's own documentation rather than
// from memory, because the two disagree:
//   * cursor.com/docs/cli/reference/parameters lists `--trust`, "Trust the
//     workspace without prompting (headless mode only)", but the installed
//     cursor-agent 2026.01.23-916f423 answers `error: unknown option '--trust'`
//     and its `--help` does not list it. FULI never passes it.
//   * `--approve-mcps` is accepted, and that build's own help says it "only
//     works with --print/headless mode", so it does nothing for the
//     interactive run FULI opens in a terminal.
//   * `cursor-agent mcp enable <name>` is documented as "Add an MCP server to
//     the local approved list"; run inside the folder it wrote
//     ~/.cursor/projects/<folder>/mcp-approvals.json, so an approval covers
//     that one folder, not the computer. The documentation does not say which.
// So no flag answers the folder question for an interactive run: FULI approves
// nothing on the person's behalf and tells them what to do. It never fakes a
// hook, and never passes a flag this CLI would refuse.
export const CURSOR_FIRST_RUN_STEP = 'The first cursor-agent run in a project folder waits for its '
  + '"trust this folder" and "approve MCP" questions, with no output until they are answered. '
  + 'Answer them once in that folder, or run `cursor-agent mcp enable fuli` there first to approve '
  + 'FULI ahead of time. Cursor documents --trust for headless runs only, and the installed CLI '
  + 'does not accept it, so FULI never passes it.';

export const cursorFirstRun = () => CURSOR_FIRST_RUN_STEP;
