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
    pub fuli_configured: bool,
    pub supports_hooks: bool,
    #[serde(default)]
    pub cli_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetupPlan {
    pub client: ClientKind,
    pub target_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub updated_content: String,
    pub already_in_desired_state: bool,
    pub applied: bool,
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
    let fuli_configured = if config_file_exists {
        fs::read_to_string(&target)
            .ok()
            .is_some_and(|raw| is_fuli_configured(client, &raw))
    } else {
        false
    };

    let resolved_cli = client_cli_program(client.canonical_name()).and_then(resolve_cli_binary);

    ClientStatus {
        client: client.canonical_name().to_string(),
        display_name: client.display_name().to_string(),
        config_path: target.display().to_string(),
        config_dir_exists,
        config_file_exists,
        fuli_configured,
        supports_hooks: client.supports_hooks(),
        cli_available: resolved_cli.is_some(),
        cli_path: resolved_cli.map(|p| p.display().to_string()),
    }
}

fn is_fuli_configured(client: ClientKind, raw: &str) -> bool {
    match client {
        ClientKind::Codex => raw.contains("[mcp_servers.fuli]"),
        ClientKind::ClaudeCode | ClientKind::Cursor => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.pointer("/mcpServers/fuli").cloned())
            .is_some(),
        ClientKind::OpenCode => serde_json::from_str::<Value>(raw)
            .ok()
            .and_then(|v| v.pointer("/mcp/fuli").cloned())
            .is_some(),
    }
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

    let mut backup_path = None;
    if apply && !already_in_desired_state {
        backup_path = write_with_backup(&target_path, &updated_content)?;
    }

    Ok(SetupPlan {
        client,
        target_path,
        backup_path,
        updated_content,
        already_in_desired_state,
        applied: apply && !already_in_desired_state,
    })
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

    if !target_path.exists() {
        return Ok(SetupPlan {
            client,
            target_path,
            backup_path: None,
            updated_content: String::new(),
            already_in_desired_state: true,
            applied: false,
        });
    }

    let existing = fs::read_to_string(&target_path)
        .map_err(|e| format!("failed to read {}: {e}", target_path.display()))?;

    let (updated_content, unchanged) = match client {
        ClientKind::ClaudeCode => remove_claude_code_json(&existing)?,
        ClientKind::Cursor => remove_json_mcp_key(&existing, "mcpServers", "fuli")?,
        ClientKind::OpenCode => remove_json_mcp_key(&existing, "mcp", "fuli")?,
        ClientKind::Codex => remove_codex_toml(&existing),
    };

    let mut backup_path = None;
    if apply && !unchanged {
        backup_path = write_with_backup(&target_path, &updated_content)?;
    }

    Ok(SetupPlan {
        client,
        target_path,
        backup_path,
        updated_content,
        already_in_desired_state: unchanged,
        applied: apply && !unchanged,
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

    let mcp_servers = root
        .entry("mcpServers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers must be a JSON object".to_string())?;
    mcp_servers.insert(
        "fuli".into(),
        json!({
            "command": fuli_bin,
            "args": ["mcp", "--client", "claude-code"]
        }),
    );

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

    if let Some(mcp) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
        mcp.remove("fuli");
    }
    if let Some(hooks) = root.get_mut("hooks").and_then(Value::as_object_mut) {
        for event_name in ["UserPromptSubmit", "PreCompact", "Stop"] {
            if let Some(entries) = hooks.get_mut(event_name).and_then(Value::as_array_mut) {
                entries.retain(|entry| {
                    !entry
                        .pointer("/hooks/0/command")
                        .and_then(Value::as_str)
                        .is_some_and(|c| c.contains(" hook --client claude-code"))
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
        "fuli".into(),
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
        "fuli".into(),
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
    if existing.contains("[mcp_servers.fuli]") {
        return (existing.to_string(), true);
    }
    let block = format!(
        "[mcp_servers.fuli]\ncommand = \"{escaped_bin}\"\nargs = [\"mcp\", \"--client\", \"codex\"]\n"
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
    if !existing.contains("[mcp_servers.fuli]") {
        return (existing.to_string(), true);
    }
    let mut out = Vec::new();
    let mut skipping = false;
    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed == "[mcp_servers.fuli]" {
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

    fn tmp_file(tag: &str, ext: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("fuli-adapters-test-{tag}-{nanos}.{ext}"))
    }

    #[test]
    fn claude_code_apply_inspect_and_safe_remove_preserve_existing_settings() {
        let cfg = tmp_file("claude", "json");
        let original = r#"{
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": [] }
  },
  "theme": "light"
}"#;
        fs::write(&cfg, original).unwrap();

        assert!(!inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);

        // Apply
        let applied = run_setup(ClientKind::ClaudeCode, Some(&cfg), "/bin/fuli", true).unwrap();
        assert!(applied.applied);
        assert!(inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);

        // Idempotent second apply
        let second = run_setup(ClientKind::ClaudeCode, Some(&cfg), "/bin/fuli", true).unwrap();
        assert!(second.already_in_desired_state);

        // Safe remove restores clean config without touching github or theme!
        let removed = remove_setup(ClientKind::ClaudeCode, Some(&cfg), true).unwrap();
        assert!(removed.applied);
        assert!(!inspect_client(ClientKind::ClaudeCode, Some(&cfg)).fuli_configured);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(saved["theme"], "light");
        assert_eq!(saved["mcpServers"]["github"]["command"], "gh-mcp");
        assert!(
            saved["hooks"]["UserPromptSubmit"]
                .as_array()
                .unwrap()
                .is_empty()
        );

        let _ = fs::remove_file(&cfg);
        let _ = fs::remove_file(format!("{}.fuli.bak", cfg.display()));
    }

    #[test]
    fn codex_cursor_and_opencode_setup_and_remove_roundtrip() {
        let codex_cfg = tmp_file("codex", "toml");
        fs::write(&codex_cfg, "model = \"o3\"\n\n[other]\nkey = 1\n").unwrap();
        let p = run_setup(ClientKind::Codex, Some(&codex_cfg), "fuli", true).unwrap();
        assert!(p.applied);
        assert!(inspect_client(ClientKind::Codex, Some(&codex_cfg)).fuli_configured);
        let r = remove_setup(ClientKind::Codex, Some(&codex_cfg), true).unwrap();
        assert!(r.applied);
        assert!(!inspect_client(ClientKind::Codex, Some(&codex_cfg)).fuli_configured);
        assert!(fs::read_to_string(&codex_cfg).unwrap().contains("[other]"));

        let cursor_cfg = tmp_file("cursor", "json");
        assert!(
            run_setup(ClientKind::Cursor, Some(&cursor_cfg), "fuli", true)
                .unwrap()
                .applied
        );
        assert!(
            remove_setup(ClientKind::Cursor, Some(&cursor_cfg), true)
                .unwrap()
                .applied
        );

        let oc_cfg = tmp_file("opencode", "json");
        assert!(
            run_setup(ClientKind::OpenCode, Some(&oc_cfg), "fuli", true)
                .unwrap()
                .applied
        );
        assert!(
            remove_setup(ClientKind::OpenCode, Some(&oc_cfg), true)
                .unwrap()
                .applied
        );

        for f in [&codex_cfg, &cursor_cfg, &oc_cfg] {
            let _ = fs::remove_file(f);
            let _ = fs::remove_file(format!("{}.fuli.bak", f.display()));
        }
    }
}
