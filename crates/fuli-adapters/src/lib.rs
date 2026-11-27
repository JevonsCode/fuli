//! Zero-SQLite, zero-GPU AI client configuration adapters for FULI.
//! Shared by `fuli-cli` (`fuli setup`, `fuli doctor`) and `fuli-context` (`fuli-ui` Settings).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

pub mod sessions;
pub use sessions::{
    DiscoveredSession, client_cli_program, discover_local_sessions, discover_local_sessions_in,
    is_client_cli_available, resolve_cli_binary,
};
/// MCP server name FULI v2 registers under. Distinct from v1's `fuli`, so v2 setup
/// never overwrites, removes or mistakes the v1 production entry for its own.
pub const V2_SERVER_KEY: &str = "fuli-next";
/// Name used by FULI v1 (Node). Only ever read, to report that v1 is also installed.
const V1_SERVER_KEY: &str = "fuli";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClientKind {
    ClaudeCode,
    Codex,
    Cursor,
    OpenCode,
}

impl ClientKind {
    pub const ALL: [Self; 4] = [Self::ClaudeCode, Self::Codex, Self::Cursor, Self::OpenCode];

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "claude" | "claude-code" | "claude_code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "cursor" => Some(Self::Cursor),
            "opencode" | "open-code" => Some(Self::OpenCode),
            _ => None,
        }
    }

    pub fn canonical_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::Cursor => "cursor",
            Self::OpenCode => "opencode",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::Cursor => "Cursor",
            Self::OpenCode => "OpenCode",
        }
    }

    pub fn supports_hooks(self) -> bool {
        matches!(self, Self::ClaudeCode)
    }

    pub fn default_config_path(self) -> PathBuf {
        let home = home_dir();
        match self {
            Self::ClaudeCode => home.join(".claude").join("settings.json"),
            Self::Codex => home.join(".codex").join("config.toml"),
            Self::Cursor => home.join(".cursor").join("mcp.json"),
            Self::OpenCode => home.join(".config").join("opencode").join("opencode.json"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClientStatus {
    pub client: String,
    pub display_name: String,
    pub config_path: String,
    pub config_dir_exists: bool,
    pub config_file_exists: bool,
    /// FULI v2 (`fuli-next`) is fully wired: MCP, plus Hooks where supported.
    pub fuli_configured: bool,
    pub supports_hooks: bool,
    #[serde(default)]
    pub cli_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    /// The old v1 `fuli` entry is present (left untouched by v2 setup).
    #[serde(default)]
    pub legacy_fuli_present: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPlan {
    pub client: ClientKind,
    pub target_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub updated_content: String,
    pub already_in_desired_state: bool,
    pub applied: bool,
    /// Client CLI commands this plan runs on apply (Claude Code MCP registration).
    #[serde(default)]
    pub commands: Vec<Vec<String>>,
}

pub fn home_dir() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
    }
}

/// Resolve the sibling `fuli` CLI executable path cleanly across Windows & macOS.
pub fn resolve_fuli_cli_path(explicit: Option<&str>) -> String {
    if let Some(p) = explicit.filter(|s| !s.trim().is_empty()) {
        return p.trim().replace('\\', "/");
    }
    let bin_name = if cfg!(windows) { "fuli.exe" } else { "fuli" };
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        let sibling = dir.join(bin_name);
        if sibling.exists() {
            return sibling.to_string_lossy().replace('\\', "/");
        }
    }
    "fuli".to_string()
}

/// Inspect all supported AI clients on this machine (pure read-only check).
pub fn inspect_all_clients() -> Vec<ClientStatus> {
    ClientKind::ALL
        .iter()
        .map(|&client| inspect_client(client, None))
        .collect()
}

pub fn inspect_client(client: ClientKind, config_override: Option<&Path>) -> ClientStatus {
    let target = config_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| client.default_config_path());
    let config_dir_exists = target.parent().is_some_and(Path::exists);
    let config_file_exists = target.exists();
    let raw = fs::read_to_string(&target).unwrap_or_default();

    let (v2, legacy) = match client {
        ClientKind::ClaudeCode => {
            let user =
                fs::read_to_string(claude_user_config_path(config_override)).unwrap_or_default();
            let settings = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
            let user = serde_json::from_str::<Value>(&user).unwrap_or(Value::Null);
            let hooks = has_claude_v2_hook(&settings);
            let mcp = user
                .pointer(&format!("/mcpServers/{V2_SERVER_KEY}"))
                .is_some();
            let legacy = user
                .pointer(&format!("/mcpServers/{V1_SERVER_KEY}"))
                .is_some()
                || settings
                    .pointer(&format!("/mcpServers/{V1_SERVER_KEY}"))
                    .is_some()
                || raw.contains("lifecycle-hook.js");
            (hooks && mcp, legacy)
        }
        ClientKind::Codex => (
            raw.contains(&format!("[mcp_servers.{V2_SERVER_KEY}]")),
            raw.contains(&format!("[mcp_servers.{V1_SERVER_KEY}]")),
        ),
        ClientKind::Cursor | ClientKind::OpenCode => {
            let section = if client == ClientKind::Cursor {
                "mcpServers"
            } else {
                "mcp"
            };
            let v = serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null);
            (
                v.pointer(&format!("/{section}/{V2_SERVER_KEY}")).is_some(),
                v.pointer(&format!("/{section}/{V1_SERVER_KEY}")).is_some(),
            )
        }
    };

    let resolved_cli = client_cli_program(client.canonical_name()).and_then(resolve_cli_binary);

    ClientStatus {
        client: client.canonical_name().to_string(),
        display_name: client.display_name().to_string(),
        config_path: target.display().to_string(),
        config_dir_exists,
        config_file_exists,
        fuli_configured: v2,
        supports_hooks: client.supports_hooks(),
        cli_available: resolved_cli.is_some(),
        cli_path: resolved_cli.map(|p| p.display().to_string()),
        legacy_fuli_present: legacy,
    }
}

/// Claude Code keeps user-scope MCP servers in `~/.claude.json`, not `settings.json`.
/// With a settings override (tests), look for `.claude.json` next to it.
fn claude_user_config_path(settings_override: Option<&Path>) -> PathBuf {
    match settings_override.and_then(Path::parent) {
        Some(dir) => dir.join(".claude.json"),
        None => home_dir().join(".claude.json"),
    }
}

fn has_claude_v2_hook(settings: &Value) -> bool {
    settings
        .pointer("/hooks/UserPromptSubmit")
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|e| {
                e.pointer("/hooks/0/command")
                    .and_then(Value::as_str)
                    .is_some_and(is_v2_claude_hook)
            })
        })
}

fn is_v2_claude_hook(command: &str) -> bool {
    command.contains(" hook --client claude-code")
}

fn claude_mcp_registered(settings_override: Option<&Path>) -> bool {
    fs::read_to_string(claude_user_config_path(settings_override))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .is_some_and(|v| v.pointer(&format!("/mcpServers/{V2_SERVER_KEY}")).is_some())
}

fn claude_mcp_add_command(fuli_bin: &str) -> Vec<String> {
    let spec = json!({
        "type": "stdio",
        "command": fuli_bin,
        "args": ["mcp", "--client", "claude-code"],
    });
    vec![
        "claude".into(),
        "mcp".into(),
        "add-json".into(),
        "--scope".into(),
        "user".into(),
        V2_SERVER_KEY.into(),
        spec.to_string(),
    ]
}

fn claude_mcp_remove_command() -> Vec<String> {
    ["claude", "mcp", "remove", "--scope", "user", V2_SERVER_KEY]
        .map(String::from)
        .to_vec()
}

/// Find the `claude` binary. Apps launched from Finder / Explorer get a minimal PATH,
/// so also probe the usual install locations. `FULI_CLAUDE_BIN` overrides.
fn resolve_claude_bin() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FULI_CLAUDE_BIN").filter(|v| !v.is_empty()) {
        return PathBuf::from(explicit);
    }
    let exe = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    let home = home_dir();
    let mut candidates: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).map(|d| d.join(exe)).collect())
        .unwrap_or_default();
    candidates.extend([
        home.join(".local").join("bin").join(exe),
        home.join(".claude").join("local").join(exe),
        PathBuf::from("/opt/homebrew/bin").join(exe),
        PathBuf::from("/usr/local/bin").join(exe),
    ]);
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(exe))
}

const CLIENT_COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

fn run_client_commands(commands: &[Vec<String>]) -> Result<(), String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    for cmd in commands {
        let program = if cmd[0] == "claude" {
            resolve_claude_bin()
        } else {
            PathBuf::from(&cmd[0])
        };
        let mut child = Command::new(&program)
            .args(&cmd[1..])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                format!(
                    "could not run `{}` ({e}); run it manually: {}",
                    program.display(),
                    cmd.join(" ")
                )
            })?;
        // Bounded: setup runs inside fuli-context's IPC handler and must never hang it.
        let deadline = Instant::now() + CLIENT_COMMAND_TIMEOUT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < deadline => thread_sleep(Duration::from_millis(50)),
                Ok(None) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("`{}` timed out; run it manually", cmd.join(" ")));
                }
                Err(e) => return Err(format!("`{}` failed: {e}", cmd.join(" "))),
            }
        };
        if !status.success() {
            return Err(format!(
                "`{}` exited with {}; run it manually",
                cmd.join(" "),
                status.code().unwrap_or(-1)
            ));
        }
    }
    Ok(())
}

fn thread_sleep(d: std::time::Duration) {
    std::thread::sleep(d);
}

/// Plan or apply idempotent FULI Hook + MCP configuration for a supported AI client.
/// Never modifies disk when `apply == false`. Creates `<file>.fuli.bak` before writing.
pub fn run_setup(
    client: ClientKind,
    config_override: Option<&Path>,
    fuli_bin: &str,
    apply: bool,
) -> Result<SetupPlan, String> {
    let target_path = config_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| client.default_config_path());

    let existing = if target_path.exists() {
        fs::read_to_string(&target_path)
            .map_err(|e| format!("failed to read {}: {e}", target_path.display()))?
    } else {
        String::new()
    };

    let (updated_content, already_in_desired_state) = match client {
        ClientKind::ClaudeCode => merge_claude_code_json(&existing, fuli_bin)?,
        ClientKind::Cursor => merge_cursor_json(&existing, fuli_bin)?,
        ClientKind::OpenCode => merge_opencode_json(&existing, fuli_bin)?,
        ClientKind::Codex => merge_codex_toml(&existing, fuli_bin),
    };

    // Claude Code: Hooks live in settings.json, MCP is registered through its own CLI
    // (user scope, stored in ~/.claude.json, which Claude Code rewrites constantly).
    let mut commands = Vec::new();
    if client == ClientKind::ClaudeCode && !claude_mcp_registered(config_override) {
        commands.push(claude_mcp_add_command(fuli_bin));
    }
    let file_unchanged = already_in_desired_state;
    let already_in_desired_state = file_unchanged && commands.is_empty();

    let mut backup_path = None;
    if apply && !file_unchanged {
        backup_path = write_with_backup(&target_path, &updated_content)?;
    }
    if apply
        && !commands.is_empty()
        && let Err(err) = apply_claude_mcp(config_override, &commands, Some(fuli_bin))
    {
        // Don't leave Hooks enabled without the MCP server they rely on.
        if !file_unchanged {
            match &backup_path {
                Some(bak) => {
                    let _ = fs::copy(bak, &target_path);
                }
                None => {
                    let _ = fs::remove_file(&target_path);
                }
            }
        }
        return Err(err);
    }

    Ok(SetupPlan {
        client,
        target_path,
        backup_path,
        updated_content,
        already_in_desired_state,
        applied: apply && !already_in_desired_state,
        commands,
    })
}

/// Run the Claude Code MCP command. With a settings override (tests / sandboxes) the
/// sibling `.claude.json` is edited directly so no real client config is touched.
fn apply_claude_mcp(
    settings_override: Option<&Path>,
    commands: &[Vec<String>],
    add_bin: Option<&str>,
) -> Result<(), String> {
    if settings_override.is_none() {
        return run_client_commands(commands);
    }
    let path = claude_user_config_path(settings_override);
    let mut root = parse_json_object(&fs::read_to_string(&path).unwrap_or_default())?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;
    match add_bin {
        Some(bin) => {
            servers.insert(
                V2_SERVER_KEY.into(),
                json!({ "type": "stdio", "command": bin, "args": ["mcp", "--client", "claude-code"] }),
            );
        }
        None => {
            servers.remove(V2_SERVER_KEY);
        }
    }
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("failed to write {}: {e}", path.display()))
}

/// Safely remove ONLY FULI's MCP server & Hook entries, preserving 100% of user's other config.
pub fn remove_setup(
    client: ClientKind,
    config_override: Option<&Path>,
    apply: bool,
) -> Result<SetupPlan, String> {
    let target_path = config_override
        .map(Path::to_path_buf)
        .unwrap_or_else(|| client.default_config_path());

    let mut commands = Vec::new();
    if client == ClientKind::ClaudeCode && claude_mcp_registered(config_override) {
        commands.push(claude_mcp_remove_command());
    }

    if !target_path.exists() {
        if apply && !commands.is_empty() {
            apply_claude_mcp(config_override, &commands, None)?;
        }
        return Ok(SetupPlan {
            client,
            target_path,
            backup_path: None,
            updated_content: String::new(),
            already_in_desired_state: commands.is_empty(),
            applied: apply && !commands.is_empty(),
            commands,
        });
    }

    let existing = fs::read_to_string(&target_path)
        .map_err(|e| format!("failed to read {}: {e}", target_path.display()))?;

    let (updated_content, unchanged) = match client {
        ClientKind::ClaudeCode => remove_claude_code_json(&existing)?,
        ClientKind::Cursor => remove_json_mcp_key(&existing, "mcpServers", V2_SERVER_KEY)?,
        ClientKind::OpenCode => remove_json_mcp_key(&existing, "mcp", V2_SERVER_KEY)?,
        ClientKind::Codex => remove_codex_toml(&existing),
    };

    let mut backup_path = None;
    if apply && !unchanged {
        backup_path = write_with_backup(&target_path, &updated_content)?;
    }
    if apply && !commands.is_empty() {
        apply_claude_mcp(config_override, &commands, None)?;
    }
    let nothing_to_do = unchanged && commands.is_empty();

    Ok(SetupPlan {
        client,
        target_path,
        backup_path,
        updated_content,
        already_in_desired_state: nothing_to_do,
        applied: apply && !nothing_to_do,
        commands,
    })
}

fn write_with_backup(target_path: &Path, content: &str) -> Result<Option<PathBuf>, String> {
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("failed to create dir {}: {e}", parent.display()))?;
    }
    let backup = if target_path.exists() {
        let bak = PathBuf::from(format!("{}.fuli.bak", target_path.display()));
        fs::copy(target_path, &bak)
            .map_err(|e| format!("failed to backup {}: {e}", bak.display()))?;
        Some(bak)
    } else {
        None
    };
    fs::write(target_path, content)
        .map_err(|e| format!("failed to write {}: {e}", target_path.display()))?;
    Ok(backup)
}

fn parse_json_object(raw: &str) -> Result<Map<String, Value>, String> {
    if raw.trim().is_empty() {
        return Ok(Map::new());
    }
    let val: Value =
        serde_json::from_str(raw).map_err(|e| format!("invalid existing JSON config: {e}"))?;
    val.as_object()
        .cloned()
        .ok_or_else(|| "existing JSON root must be an object".to_string())
}

fn merge_claude_code_json(existing: &str, fuli_bin: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object(existing)?;
    let before = serde_json::to_string(&root).unwrap_or_default();

    // MCP is NOT written here: Claude Code ignores `mcpServers` in settings.json.
    let hooks = root
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "hooks must be a JSON object".to_string())?;

    let prompt_cmd = format!("\"{fuli_bin}\" hook --client claude-code --event prompt");
    let compact_cmd = format!("\"{fuli_bin}\" hook --client claude-code --event pre_compact");
    ensure_claude_hook(hooks, "UserPromptSubmit", &prompt_cmd);
    ensure_claude_hook(hooks, "PreCompact", &compact_cmd);

    let after = serde_json::to_string(&root).unwrap_or_default();
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    Ok((format!("{pretty}\n"), before == after))
}

fn ensure_claude_hook(hooks: &mut Map<String, Value>, event_name: &str, command: &str) {
    let arr = hooks
        .entry(event_name)
        .or_insert_with(|| json!([]))
        .as_array_mut();
    let Some(entries) = arr else { return };

    let already = entries.iter().any(|entry| {
        entry
            .pointer("/hooks/0/command")
            .and_then(Value::as_str)
            .is_some_and(|c| c == command)
    });
    if !already {
        entries.push(json!({
            "hooks": [{
                "type": "command",
                "command": command
            }]
        }));
    }
}

fn remove_claude_code_json(existing: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object(existing)?;
    let before = serde_json::to_string(&root).unwrap_or_default();

    // Only v2 Hooks are removed. v1's `mcpServers.fuli` / lifecycle hooks stay untouched.
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for event_name in ["UserPromptSubmit", "PreCompact", "Stop"] {
            if let Some(entries) = hooks.get_mut(event_name).and_then(Value::as_array_mut) {
                entries.retain(|entry| {
                    !entry
                        .pointer("/hooks/0/command")
                        .and_then(Value::as_str)
                        .is_some_and(is_v2_claude_hook)
                });
            }
        }
    }

    let after = serde_json::to_string(&root).unwrap_or_default();
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    Ok((format!("{pretty}\n"), before == after))
}

fn merge_cursor_json(existing: &str, fuli_bin: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object(existing)?;
    let before = serde_json::to_string(&root).unwrap_or_default();

    let mcp_servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;
    mcp_servers.insert(
        V2_SERVER_KEY.into(),
        json!({
            "command": fuli_bin,
            "args": ["mcp", "--client", "cursor"]
        }),
    );

    let after = serde_json::to_string(&root).unwrap_or_default();
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    Ok((format!("{pretty}\n"), before == after))
}

fn merge_opencode_json(existing: &str, fuli_bin: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object(existing)?;
    let before = serde_json::to_string(&root).unwrap_or_default();

    let mcp = root
        .entry("mcp")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcp must be a JSON object".to_string())?;
    mcp.insert(
        V2_SERVER_KEY.into(),
        json!({
            "type": "local",
            "command": [fuli_bin, "mcp", "--client", "opencode"],
            "enabled": true
        }),
    );

    let after = serde_json::to_string(&root).unwrap_or_default();
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    Ok((format!("{pretty}\n"), before == after))
}

fn remove_json_mcp_key(existing: &str, section: &str, key: &str) -> Result<(String, bool), String> {
    let mut root = parse_json_object(existing)?;
    let before = serde_json::to_string(&root).unwrap_or_default();
    if let Some(sec) = root.get_mut(section).and_then(Value::as_object_mut) {
        sec.remove(key);
    }
    let after = serde_json::to_string(&root).unwrap_or_default();
    let pretty = serde_json::to_string_pretty(&Value::Object(root))
        .map_err(|e| format!("JSON serialize error: {e}"))?;
    Ok((format!("{pretty}\n"), before == after))
}

fn merge_codex_toml(existing: &str, fuli_bin: &str) -> (String, bool) {
    let escaped_bin = fuli_bin.replace('\\', "/");
    let header = format!("[mcp_servers.{V2_SERVER_KEY}]");
    if existing.contains(&header) {
        return (existing.to_string(), true);
    }
    let block = format!(
        "{header}\ncommand = \"{escaped_bin}\"\nargs = [\"mcp\", \"--client\", \"codex\"]\n"
    );
    let out = if existing.trim().is_empty() {
        block
    } else if existing.ends_with('\n') {
        format!("{existing}\n{block}")
    } else {
        format!("{existing}\n\n{block}")
    };
    (out, false)
}

fn remove_codex_toml(existing: &str) -> (String, bool) {
    let header = format!("[mcp_servers.{V2_SERVER_KEY}]");
    let has_header = existing
        .lines()
        .any(|l| l.split('#').next().unwrap_or("").trim() == header);
    if !has_header {
        return (existing.to_string(), true);
    }
    let mut out = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        // Table headers may carry a trailing comment: `[mcp_servers.fuli] # v1`.
        let trimmed = line.split('#').next().unwrap_or("").trim();
        if trimmed == header {
            skipping = true;
            continue;
        }
        if skipping && trimmed.starts_with('[') && trimmed.ends_with(']') {
            skipping = false;
        }
        if !skipping {
            out.push(line);
        }
    }
    let mut joined = out.join("\n").trim_end().to_string();
    if !joined.is_empty() {
        joined.push('\n');
    }
    (joined, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Fresh directory per test so the sibling `.claude.json` never leaks between tests.
    fn tmp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fuli-adapters-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn claude_code_hooks_in_settings_mcp_in_user_config_and_safe_remove() {
        let dir = tmp_dir("claude");
        let cfg = dir.join("settings.json");
        fs::write(&cfg, r#"{ "theme": "light" }"#).unwrap();
        let user = dir.join(".claude.json");
        fs::write(
            &user,
            r#"{ "mcpServers": { "github": { "command": "gh-mcp" } } }"#,
        )
        .unwrap();

        assert!(!inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);

        let applied = run_setup(ClientKind::ClaudeCode, Some(&cfg), "/bin/fuli", true).unwrap();
        assert!(applied.applied);
        assert_eq!(applied.commands[0][..3], ["claude", "mcp", "add-json"]);
        assert!(inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);
        let settings: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert!(
            settings.get("mcpServers").is_none(),
            "MCP must not go into settings.json"
        );
        let u: Value = serde_json::from_str(&fs::read_to_string(&user).unwrap()).unwrap();
        assert_eq!(u["mcpServers"][V2_SERVER_KEY]["args"][0], "mcp");
        assert_eq!(u["mcpServers"]["github"]["command"], "gh-mcp");

        let second = run_setup(ClientKind::ClaudeCode, Some(&cfg), "/bin/fuli", true).unwrap();
        assert!(second.already_in_desired_state);
        assert!(second.commands.is_empty());

        let removed = remove_setup(ClientKind::ClaudeCode, Some(&cfg), true).unwrap();
        assert!(removed.applied);
        assert!(!inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(saved["theme"], "light");
        assert!(
            saved["hooks"]["UserPromptSubmit"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let u: Value = serde_json::from_str(&fs::read_to_string(&user).unwrap()).unwrap();
        assert!(u["mcpServers"].get(V2_SERVER_KEY).is_none());
        assert_eq!(u["mcpServers"]["github"]["command"], "gh-mcp");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn v1_entries_are_reported_but_never_counted_as_v2_or_overwritten() {
        let dir = tmp_dir("v1");
        let v1_hook = "node /Applications/FULI.app/src/agents/claude-code/lifecycle-hook.js --event UserPromptSubmit";

        let cfg = dir.join("settings.json");
        fs::write(&cfg, json!({ "hooks": { "UserPromptSubmit": [ { "hooks": [ { "type": "command", "command": v1_hook } ] } ] } }).to_string()).unwrap();
        fs::write(
            dir.join(".claude.json"),
            r#"{ "mcpServers": { "fuli": { "command": "node", "args": ["mcp-server.js"] } } }"#,
        )
        .unwrap();
        let st = inspect_client(ClientKind::ClaudeCode, Some(&cfg));
        assert!(!st.fuli_configured);
        assert!(st.legacy_fuli_present);
        run_setup(ClientKind::ClaudeCode, Some(&cfg), "/bin/fuli", true).unwrap();
        remove_setup(ClientKind::ClaudeCode, Some(&cfg), true).unwrap();
        let settings = fs::read_to_string(&cfg).unwrap();
        assert!(
            settings.contains("lifecycle-hook.js"),
            "v1 hook must survive v2 setup + remove"
        );
        let u: Value =
            serde_json::from_str(&fs::read_to_string(dir.join(".claude.json")).unwrap()).unwrap();
        assert_eq!(u["mcpServers"]["fuli"]["args"][0], "mcp-server.js");

        let cursor = dir.join("mcp.json");
        fs::write(
            &cursor,
            r#"{ "mcpServers": { "fuli": { "command": "node", "args": ["mcp-server.js"] } } }"#,
        )
        .unwrap();
        let st = inspect_client(ClientKind::Cursor, Some(&cursor));
        assert!(!st.fuli_configured && st.legacy_fuli_present);
        run_setup(ClientKind::Cursor, Some(&cursor), "/bin/fuli", true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&cursor).unwrap()).unwrap();
        assert_eq!(v["mcpServers"]["fuli"]["args"][0], "mcp-server.js");
        assert_eq!(v["mcpServers"][V2_SERVER_KEY]["args"][0], "mcp");
        remove_setup(ClientKind::Cursor, Some(&cursor), true).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&cursor).unwrap()).unwrap();
        assert!(v["mcpServers"].get("fuli").is_some());

        let codex = dir.join("config.toml");
        fs::write(&codex, "[mcp_servers.fuli]\ncommand = \"node\"\n").unwrap();
        let st = inspect_client(ClientKind::Codex, Some(&codex));
        assert!(!st.fuli_configured && st.legacy_fuli_present);
        assert!(
            run_setup(ClientKind::Codex, Some(&codex), "fuli", true)
                .unwrap()
                .applied
        );
        assert!(inspect_client(ClientKind::Codex, Some(&codex)).fuli_configured);
        remove_setup(ClientKind::Codex, Some(&codex), true).unwrap();
        let after = fs::read_to_string(&codex).unwrap();
        assert!(after.contains("[mcp_servers.fuli]"));
        assert!(!after.contains(V2_SERVER_KEY));

        // A v1 table header with a trailing comment right after the v2 block must survive.
        let codex2 = dir.join("config2.toml");
        fs::write(
            &codex2,
            "[mcp_servers.fuli-next] # v2\ncommand = \"fuli\"\n\n[mcp_servers.fuli] # v1\ncommand = \"node\"\n",
        )
        .unwrap();
        remove_setup(ClientKind::Codex, Some(&codex2), true).unwrap();
        let after = fs::read_to_string(&codex2).unwrap();
        assert!(after.contains("[mcp_servers.fuli] # v1"));
        assert!(after.contains("command = \"node\""));
        assert!(!after.contains("fuli-next"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn codex_cursor_and_opencode_setup_and_remove_roundtrip() {
        let dir = tmp_dir("rt");
        let codex_cfg = dir.join("config.toml");
        fs::write(&codex_cfg, "model = \"o3\"\n\n[other]\nkey = 1\n").unwrap();
        assert!(
            run_setup(ClientKind::Codex, Some(&codex_cfg), "fuli", true)
                .unwrap()
                .applied
        );
        assert!(inspect_client(ClientKind::Codex, Some(&codex_cfg)).fuli_configured);
        assert!(
            remove_setup(ClientKind::Codex, Some(&codex_cfg), true)
                .unwrap()
                .applied
        );
        assert!(!inspect_client(ClientKind::Codex, Some(&codex_cfg)).fuli_configured);
        assert!(fs::read_to_string(&codex_cfg).unwrap().contains("[other]"));

        for (client, name) in [
            (ClientKind::Cursor, "mcp.json"),
            (ClientKind::OpenCode, "opencode.json"),
        ] {
            let f = dir.join(name);
            assert!(run_setup(client, Some(&f), "fuli", true).unwrap().applied);
            assert!(inspect_client(client, Some(&f)).fuli_configured);
            assert!(remove_setup(client, Some(&f), true).unwrap().applied);
            assert!(!inspect_client(client, Some(&f)).fuli_configured);
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
