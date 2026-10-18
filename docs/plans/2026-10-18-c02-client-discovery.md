# C-02 client discovery and connection

Approved scope: CL C-02, 2026-10-18. Branch JVS-AC/c02-client-discovery.

1. Register existing Codex, Claude Code, Cursor and Claude Desktop adapters without changing their setup contract; keep their existing regression tests.
2. Add Gemini CLI, OpenCode, Qwen Code and Kiro adapters using official global configuration formats. Test discovery, preservation, idempotence, explicit profiles and scoped disconnect in temporary directories. Reject unsupported or malformed configuration before writing.
3. Reuse setup backup, skill installation and self-check for a server-owned, client-ID-only connection endpoint. Preserve uninstall ordering and avoid changing runtime configuration or capture preferences.
4. Add detected-client connection actions and restart feedback to settings, including pending/error states and component/API tests.
5. Run relevant Node and web tests, typecheck/build and independent review; fetch/merge main, rerun impacted checks and open PR for CL.

Official references:
- https://geminicli.com/docs/tools/mcp-server/
- https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
- https://opencode.ai/docs/config/
- https://opencode.ai/docs/mcp-servers/
- https://kiro.dev/docs/mcp/configuration/

Tests never write daily client configuration. No history import, trust bypass or release is included.
