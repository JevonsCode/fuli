// Cursor's CLI asks two questions the first time it runs in a project folder:
// whether to trust the folder, and whether to approve each MCP server. Started
// by something that cannot answer them — a background process, another Agent —
// it waits with no output at all, which reads as a session that started and
// then did nothing (rec#145).
//
// Checked against `cursor-agent --help` and `cursor-agent mcp --help`
// (2026.01.23-916f423) rather than from memory:
//   * there is no `--trust` flag; the folder question has no flag at all;
//   * `--approve-mcps` exists but its own help says "only works with
//     --print/headless mode", so it does nothing for an interactive run;
//   * `cursor-agent mcp enable <name>` "Add an MCP server to the local approved
//     list"; run inside the folder it writes
//     ~/.cursor/projects/<folder>/mcp-approvals.json, so an approval covers that
//     one folder, not the computer.
// FULI therefore pre-approves nothing on the person's behalf and says what to
// do instead. It never fakes a hook or a flag that does not exist.
export const CURSOR_FIRST_RUN_STEP = 'The first cursor-agent run in a project folder waits for its '
  + '"trust this folder" and "approve MCP" questions, with no output until they are answered. '
  + 'Answer them once in that folder, or run `cursor-agent mcp enable fuli` there first to approve '
  + 'FULI ahead of time (Cursor has no flag that pre-trusts a folder, and --approve-mcps applies to '
  + '--print runs only).';

export const cursorFirstRun = () => CURSOR_FIRST_RUN_STEP;
