//! Cross-platform CLI binary resolution (Win `.exe`/`.cmd` + macOS Homebrew/local bins)
//! and bounded read-only local session discovery for Claude Code, Codex, and OpenCode.

use std::cmp::Reverse;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::home_dir;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiscoveredSession {
    pub client_id: String,
    pub session_id: String,
    pub cwd: String,
    pub summary: String,
    pub modified_secs: u64,
}

/// Map a canonical FULI client name to its runnable local CLI executable name (if any).
pub fn client_cli_program(client: &str) -> Option<&'static str> {
    match client.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" | "claude_code" => Some("claude"),
        "codex" => Some("codex"),
        "opencode" | "open-code" | "open_code" => Some("opencode"),
        _ => None,
    }
}

/// Resolve a CLI binary across `$PATH` plus standard macOS/Windows user install locations
/// (crucial when GUI apps launch without full interactive shell PATH).
/// On Windows, also resolves `.exe`, `.cmd`, and `.bat` shims (e.g. `codex.cmd`).
pub fn resolve_cli_binary(program: &str) -> Option<PathBuf> {
    let trimmed = program.trim();
    if trimmed.is_empty() {
        return None;
    }

    let direct = PathBuf::from(trimmed);
    if direct.components().count() > 1 && direct.is_file() {
        return Some(direct);
    }

    let mut search_dirs: Vec<PathBuf> = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        search_dirs.extend(std::env::split_paths(&path_var));
    }

    let home = home_dir();
    search_dirs.push(home.join(".local").join("bin"));
    search_dirs.push(home.join(".cargo").join("bin"));
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            search_dirs.push(PathBuf::from(appdata).join("npm"));
        }
    }
    #[cfg(not(windows))]
    {
        search_dirs.push(PathBuf::from("/opt/homebrew/bin"));
        search_dirs.push(PathBuf::from("/usr/local/bin"));
        search_dirs.push(home.join(".npm-global").join("bin"));
    }

    #[cfg(windows)]
    let exts: &[&str] = &["", ".exe", ".cmd", ".bat", ".com"];
    #[cfg(not(windows))]
    let exts: &[&str] = &[""];

    for dir in search_dirs {
        if !dir.is_dir() {
            continue;
        }
        for ext in exts {
            let candidate = if ext.is_empty() || trimmed.to_ascii_lowercase().ends_with(ext) {
                dir.join(trimmed)
            } else {
                dir.join(format!("{trimmed}{ext}"))
            };
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Check whether a FULI client has a runnable local CLI binary installed on this machine.
pub fn is_client_cli_available(client: &str) -> bool {
    client_cli_program(client)
        .and_then(resolve_cli_binary)
        .is_some()
}

/// Discover recent local AI client sessions on this machine (pure read-only, strictly bounded).
pub fn discover_local_sessions(limit: usize) -> Vec<DiscoveredSession> {
    discover_local_sessions_in(&home_dir(), limit)
}

/// Discover recent local AI client sessions rooted under a given home directory.
pub fn discover_local_sessions_in(home: &Path, limit: usize) -> Vec<DiscoveredSession> {
    let cap = limit.clamp(1, 100);
    let mut out = Vec::new();
    discover_claude_sessions(&home.join(".claude").join("projects"), cap, &mut out);
    discover_codex_sessions(&home.join(".codex").join("sessions"), cap, &mut out);
    discover_opencode_sessions(
        &home
            .join(".local")
            .join("share")
            .join("opencode")
            .join("storage")
            .join("session"),
        cap,
        &mut out,
    );

    out.sort_by_key(|s| Reverse(s.modified_secs));
    out.truncate(cap);
    out
}

fn file_mtime_secs(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn discover_claude_sessions(projects_root: &Path, limit: usize, out: &mut Vec<DiscoveredSession>) {
    let Ok(project_dirs) = fs::read_dir(projects_root) else {
        return;
    };

    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for entry in project_dirs.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Ok(children) = fs::read_dir(&p) else {
            continue;
        };
        for f in children.flatten() {
            let fp = f.path();
            if fp.extension().and_then(|e| e.to_str()) == Some("jsonl")
                && let Some(stem) = fp.file_stem().and_then(|s| s.to_str())
                && !stem.starts_with("agent-")
            {
                files.push((file_mtime_secs(&fp), fp));
            }
        }
    }

    files.sort_by_key(|item| Reverse(item.0));
    for (mtime, path) in files.into_iter().take(limit) {
        if let Some(sess) = parse_claude_jsonl(&path, mtime) {
            out.push(sess);
        }
    }
}

fn parse_claude_jsonl(path: &Path, modified_secs: u64) -> Option<DiscoveredSession> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let mut cwd = String::new();
    let mut summary = String::new();

    for line in reader.lines().take(60).flatten() {
        if line.len() > 65_536 {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(sid) = v.get("sessionId").and_then(Value::as_str)
            && !sid.trim().is_empty()
        {
            session_id = sid.trim().to_string();
        }
        if cwd.is_empty()
            && let Some(c) = v.get("cwd").and_then(Value::as_str)
            && !c.trim().is_empty()
        {
            cwd = c.trim().to_string();
        }
        if summary.is_empty()
            && v.get("type").and_then(Value::as_str) == Some("user")
            && let Some(msg) = v.get("message")
            && let Some(text) = extract_user_text(msg.get("content"))
        {
            summary = text;
        }
        if !cwd.is_empty() && !summary.is_empty() {
            break;
        }
    }

    if session_id.is_empty() || cwd.is_empty() {
        return None;
    }
    if summary.is_empty() {
        summary = "Claude Code 本地历史会话".to_string();
    }
    Some(DiscoveredSession {
        client_id: "claude-code".to_string(),
        session_id,
        cwd,
        summary,
        modified_secs,
    })
}

fn discover_codex_sessions(sessions_root: &Path, limit: usize, out: &mut Vec<DiscoveredSession>) {
    if !sessions_root.is_dir() {
        return;
    }
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    collect_jsonl_recursive(sessions_root, 4, &mut files);
    files.sort_by_key(|item| Reverse(item.0));

    for (mtime, path) in files.into_iter().take(limit) {
        if let Some(sess) = parse_codex_jsonl(&path, mtime) {
            out.push(sess);
        }
    }
}

fn collect_jsonl_recursive(dir: &Path, max_depth: usize, out: &mut Vec<(u64, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if max_depth > 0 {
                collect_jsonl_recursive(&p, max_depth - 1, out);
            }
        } else if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push((file_mtime_secs(&p), p));
        }
    }
}

fn parse_codex_jsonl(path: &Path, modified_secs: u64) -> Option<DiscoveredSession> {
    let file = File::open(path).ok()?;
    let reader = BufReader::new(file);

    let mut session_id = String::new();
    let mut cwd = String::new();
    let mut summary = String::new();

    for line in reader.lines().take(50).flatten() {
        if line.len() > 65_536 {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let kind = v.get("type").and_then(Value::as_str).unwrap_or("");
        if kind == "session_meta"
            && let Some(payload) = v.get("payload")
        {
            if let Some(sid) = payload
                .get("session_id")
                .or_else(|| payload.get("id"))
                .and_then(Value::as_str)
            {
                session_id = sid.trim().to_string();
            }
            if let Some(c) = payload.get("cwd").and_then(Value::as_str) {
                cwd = c.trim().to_string();
            }
        } else if summary.is_empty()
            && kind == "event_msg"
            && let Some(payload) = v.get("payload")
            && payload.get("type").and_then(Value::as_str) == Some("user_message")
            && let Some(msg) = payload
                .get("message")
                .or_else(|| payload.get("text"))
                .and_then(Value::as_str)
            && let Some(clean) = clean_summary_text(msg)
        {
            summary = clean;
        } else if summary.is_empty()
            && kind == "response_item"
            && let Some(payload) = v.get("payload")
            && payload.get("role").and_then(Value::as_str) == Some("user")
            && let Some(text) = extract_user_text(payload.get("content"))
        {
            summary = text;
        }
        if !session_id.is_empty() && !cwd.is_empty() && !summary.is_empty() {
            break;
        }
    }

    if session_id.is_empty() || cwd.is_empty() {
        return None;
    }
    if summary.is_empty() {
        summary = "Codex 本地历史会话".to_string();
    }
    Some(DiscoveredSession {
        client_id: "codex".to_string(),
        session_id,
        cwd,
        summary,
        modified_secs,
    })
}

fn discover_opencode_sessions(root: &Path, limit: usize, out: &mut Vec<DiscoveredSession>) {
    if !root.is_dir() {
        return;
    }
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    collect_json_recursive(root, 3, &mut files);
    files.sort_by_key(|item| Reverse(item.0));

    for (mtime, path) in files.into_iter().take(limit) {
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(v) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let sid = v
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let cwd = v
            .get("directory")
            .or_else(|| v.get("cwd"))
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if sid.is_empty() || cwd.is_empty() {
            continue;
        }
        let title = v
            .get("title")
            .and_then(Value::as_str)
            .and_then(clean_summary_text)
            .unwrap_or_else(|| "OpenCode 本地历史会话".to_string());
        out.push(DiscoveredSession {
            client_id: "opencode".to_string(),
            session_id: sid.to_string(),
            cwd: cwd.to_string(),
            summary: title,
            modified_secs: mtime,
        });
    }
}

fn collect_json_recursive(dir: &Path, max_depth: usize, out: &mut Vec<(u64, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() {
            if max_depth > 0 {
                collect_json_recursive(&p, max_depth - 1, out);
            }
        } else if p.extension().and_then(|e| e.to_str()) == Some("json") {
            out.push((file_mtime_secs(&p), p));
        }
    }
}

fn extract_user_text(content: Option<&Value>) -> Option<String> {
    let val = content?;
    if let Some(s) = val.as_str() {
        return clean_summary_text(s);
    }
    if let Some(arr) = val.as_array() {
        for item in arr {
            if let Some(t) = item.get("text").and_then(Value::as_str)
                && let Some(clean) = clean_summary_text(t)
            {
                return Some(clean);
            }
        }
    }
    None
}

fn clean_summary_text(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("<environment_context>")
        || trimmed.starts_with("<system")
        || trimmed.starts_with("<command-")
        || trimmed.starts_with("# AGENTS.md")
    {
        return None;
    }
    let single_line: String = trimmed
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if single_line.is_empty() {
        return None;
    }
    let clipped: String = single_line.chars().take(72).collect();
    Some(clipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn discovers_claude_codex_and_opencode_sessions_in_isolated_temp_home() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("fuli-sess-disc-{nanos}"));

        let claude_dir = root.join(".claude").join("projects").join("demo-fuli");
        fs::create_dir_all(&claude_dir).unwrap();
        fs::write(
            claude_dir.join("cc-sess-001.jsonl"),
            concat!(
                "{\"type\":\"attachment\",\"sessionId\":\"cc-sess-001\",\"cwd\":\"t:/workspace/fuli\"}\n",
                "{\"type\":\"user\",\"sessionId\":\"cc-sess-001\",\"cwd\":\"t:/workspace/fuli\",\"message\":{\"role\":\"user\",\"content\":\"帮我把圆桌超时测试补齐\"}}\n"
            ),
        )
        .unwrap();

        let codex_dir = root
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("11")
            .join("28");
        fs::create_dir_all(&codex_dir).unwrap();
        fs::write(
            codex_dir.join("rollout-2026-11-28-cx-sess-002.jsonl"),
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"session_id\":\"cx-sess-002\",\"cwd\":\"t:/workspace/fuli\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"重构 GPUI 标题栏和动效\"}}\n"
            ),
        )
        .unwrap();

        let oc_dir = root
            .join(".local")
            .join("share")
            .join("opencode")
            .join("storage")
            .join("session")
            .join("proj1");
        fs::create_dir_all(&oc_dir).unwrap();
        fs::write(
            oc_dir.join("oc-sess-003.json"),
            "{\"id\":\"oc-sess-003\",\"directory\":\"t:/workspace/shop-web\",\"title\":\"修复购物车按钮圆角\"}",
        )
        .unwrap();

        let found = discover_local_sessions_in(&root, 20);
        assert_eq!(found.len(), 3);
        assert!(found.iter().any(|s| {
            s.client_id == "claude-code"
                && s.session_id == "cc-sess-001"
                && s.summary.contains("圆桌超时")
        }));
        assert!(found.iter().any(|s| {
            s.client_id == "codex" && s.session_id == "cx-sess-002" && s.summary.contains("GPUI")
        }));
        assert!(found.iter().any(|s| {
            s.client_id == "opencode"
                && s.session_id == "oc-sess-003"
                && s.summary.contains("购物车")
        }));

        let _ = fs::remove_dir_all(&root);
    }
}
