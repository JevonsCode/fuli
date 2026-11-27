use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientKind {
    ClaudeCode,
    Codex,
    Cursor,
    OpenCode,
}

impl ClientKind {
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SetupPlan {
    pub client: ClientKind,
    pub target_path: PathBuf,
    pub backup_path: Option<PathBuf>,
    pub updated_content: String,
    pub already_configured: bool,
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

pub fn resolve_fuli_bin_path(explicit: Option<&str>) -> String {
    if let Some(p) = explicit.filter(|s| !s.trim().is_empty()) {
        return p.trim().to_string();
    }
    std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| "fuli".to_string())
}

/// Plan or apply idempotent FULI Hook + MCP configuration for a supported AI client.
/// Never touches disk when `apply == false` (dry-run preview).
/// When `apply == true` and the target file already exists, writes a `.fuli.bak` backup first.
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

    let (updated_content, already_configured) = match client {
        ClientKind::ClaudeCode => merge_claude_code_json(&existing, fuli_bin)?,
        ClientKind::Cursor => merge_cursor_json(&existing, fuli_bin)?,
        ClientKind::OpenCode => merge_opencode_json(&existing, fuli_bin)?,
        ClientKind::Codex => merge_codex_toml(&existing, fuli_bin),
    };

    let mut backup_path = None;
    if apply && !already_configured {
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("failed to create dir {}: {e}", parent.display()))?;
        }
        if target_path.exists() {
            let bak = PathBuf::from(format!("{}.fuli.bak", target_path.display()));
            fs::copy(&target_path, &bak)
                .map_err(|e| format!("failed to backup {}: {e}", bak.display()))?;
            backup_path = Some(bak);
        }
        fs::write(&target_path, &updated_content)
            .map_err(|e| format!("failed to write {}: {e}", target_path.display()))?;
    }

    Ok(SetupPlan {
        client,
        target_path,
        backup_path,
        updated_content,
        already_configured,
        applied: apply && !already_configured,
    })
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

    // 1. Merge mcpServers.fuli without touching other MCP servers
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

    // 2. Merge UserPromptSubmit & PreCompact hooks idempotently
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmp_file(tag: &str, ext: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("fuli-setup-test-{tag}-{nanos}.{ext}"))
    }

    #[test]
    fn claude_code_setup_dry_run_and_idempotent_apply_with_backup() {
        let cfg = tmp_file("claude", "json");
        let original = r#"{
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": [] }
  },
  "theme": "light"
}"#;
        fs::write(&cfg, original).unwrap();

        // 1. Dry-run never writes disk
        let dry = run_setup(
            ClientKind::ClaudeCode,
            Some(&cfg),
            "/usr/local/bin/fuli",
            false,
        )
        .unwrap();
        assert!(!dry.applied);
        assert!(!dry.already_configured);
        assert_eq!(fs::read_to_string(&cfg).unwrap(), original);

        // 2. Apply creates backup and preserves existing servers + theme
        let applied = run_setup(
            ClientKind::ClaudeCode,
            Some(&cfg),
            "/usr/local/bin/fuli",
            true,
        )
        .unwrap();
        assert!(applied.applied);
        let bak = applied.backup_path.expect("backup created");
        assert!(bak.exists());

        let saved: Value = serde_json::from_str(&fs::read_to_string(&cfg).unwrap()).unwrap();
        assert_eq!(saved["theme"], "light");
        assert_eq!(saved["mcpServers"]["github"]["command"], "gh-mcp");
        assert_eq!(
            saved["mcpServers"]["fuli"]["command"],
            "/usr/local/bin/fuli"
        );
        assert_eq!(
            saved["hooks"]["UserPromptSubmit"].as_array().unwrap().len(),
            1
        );
        assert_eq!(saved["hooks"]["PreCompact"].as_array().unwrap().len(), 1);

        // 3. Re-running is 100% idempotent
        let second = run_setup(
            ClientKind::ClaudeCode,
            Some(&cfg),
            "/usr/local/bin/fuli",
            true,
        )
        .unwrap();
        assert!(second.already_configured);
        assert!(!second.applied);

        let _ = fs::remove_file(&cfg);
        let _ = fs::remove_file(&bak);
    }

    #[test]
    fn codex_cursor_and_opencode_setup_work_cleanly() {
        let codex_cfg = tmp_file("codex", "toml");
        fs::write(&codex_cfg, "model = \"o3\"\n").unwrap();
        let p1 = run_setup(ClientKind::Codex, Some(&codex_cfg), "fuli", true).unwrap();
        assert!(p1.applied);
        assert!(p1.updated_content.contains("model = \"o3\""));
        assert!(p1.updated_content.contains("[mcp_servers.fuli]"));
        let p2 = run_setup(ClientKind::Codex, Some(&codex_cfg), "fuli", true).unwrap();
        assert!(p2.already_configured);

        let cursor_cfg = tmp_file("cursor", "json");
        let cur = run_setup(ClientKind::Cursor, Some(&cursor_cfg), "fuli", true).unwrap();
        assert!(cur.applied);
        assert!(cur.updated_content.contains("\"cursor\""));

        let oc_cfg = tmp_file("opencode", "json");
        let oc = run_setup(ClientKind::OpenCode, Some(&oc_cfg), "fuli", true).unwrap();
        assert!(oc.applied);
        assert!(oc.updated_content.contains("\"opencode\""));

        for p in [&codex_cfg, &cursor_cfg, &oc_cfg] {
            let _ = fs::remove_file(p);
            let _ = fs::remove_file(format!("{}.fuli.bak", p.display()));
        }
    }
}
