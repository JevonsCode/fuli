//! Deterministic identity & text normalization helpers (zero I/O).

/// Normalize a human-typed name (project/agent/KB) into a stable lookup key:
/// trim, collapse whitespace, lowercase. Preserves CJK, punctuation, and symbols.
pub fn normalize_name_key(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Canonicalize a Git remote URL so SSH and HTTPS forms of the same repository
/// always map to the exact same key across macOS and Windows.
///
/// Examples:
/// - `git@github.com:JevonsCode/fuli.git` -> `github.com/jevonscode/fuli`
/// - `https://github.com/JevonsCode/fuli.git/` -> `github.com/jevonscode/fuli`
/// - `ssh://git@github.com:22/JevonsCode/fuli` -> `github.com/jevonscode/fuli`
pub fn canonicalize_git_remote(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let without_scheme = if let Some(rest) = trimmed.strip_prefix("https://") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("ssh://") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("git://") {
        rest
    } else {
        trimmed
    };

    // Strip optional user@ prefix (e.g. git@ or token@)
    let without_user = match without_scheme.find('@') {
        Some(at_idx) => {
            let slash_idx = without_scheme.find('/').unwrap_or(usize::MAX);
            if at_idx < slash_idx {
                &without_scheme[at_idx + 1..]
            } else {
                without_scheme
            }
        }
        None => without_scheme,
    };

    // Handle SCP-style `host:owner/repo` vs `host:port/owner/repo` vs `host/owner/repo`
    let normalized = if let Some(colon_idx) = without_user.find(':') {
        let before = &without_user[..colon_idx];
        let after = &without_user[colon_idx + 1..];
        if !before.contains('/') {
            // Check if `after` begins with digits followed by '/' (an explicit port)
            if let Some(slash_idx) = after.find('/') {
                let maybe_port = &after[..slash_idx];
                if !maybe_port.is_empty() && maybe_port.chars().all(|c| c.is_ascii_digit()) {
                    format!("{before}/{}", &after[slash_idx + 1..])
                } else {
                    format!("{before}/{after}")
                }
            } else {
                format!("{before}/{after}")
            }
        } else {
            without_user.to_string()
        }
    } else {
        without_user.to_string()
    };

    let cleaned = normalized
        .trim_matches('/')
        .trim_end_matches(".git")
        .trim_matches('/')
        .to_lowercase();

    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned)
    }
}

/// Canonicalize a local directory path for deterministic comparisons on Windows & Unix.
pub fn normalize_dir_path(raw: &str) -> String {
    let mut s = raw.trim().replace('\\', "/");
    while s.len() > 1 && s.ends_with('/') {
        // Keep `C:/` root intact
        if s.len() == 3 && s.as_bytes()[1] == b':' {
            break;
        }
        s.pop();
    }
    // Fold Windows drive letter to lowercase (`T:/workspace/fuli` -> `t:/workspace/fuli`)
    if s.len() >= 2 && s.as_bytes()[1] == b':' {
        let drive = (s.as_bytes()[0] as char).to_ascii_lowercase();
        let rest = &s[1..];
        return format!("{drive}{rest}");
    }
    s
}

/// Extract the final path segment (directory name) cleanly across `/` and `\`.
pub fn path_basename(raw: &str) -> Option<String> {
    let norm = normalize_dir_path(raw);
    let last = norm.rsplit('/').find(|seg| !seg.is_empty())?;
    if last.ends_with(':') {
        return None;
    }
    Some(last.to_string())
}

/// Deterministic zero-model detector for explicit user "remember / repeat" signals
/// so FULI knows when a user directly stated a rule/fact or reminded the AI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RememberSignal {
    None,
    ExplicitRemember,
    RepeatReminder,
}

pub fn detect_remember_signal(user_text: &str) -> RememberSignal {
    let lower = user_text.to_lowercase();
    let repeat_phrases = [
        "上次就说过",
        "不是讲过了吗",
        "我已经说过",
        "怎么又忘了",
        "之前说过",
        "i already told you",
        "we already agreed",
        "told you before",
    ];
    if repeat_phrases.iter().any(|p| lower.contains(p)) {
        return RememberSignal::RepeatReminder;
    }

    let explicit_phrases = [
        "记住",
        "以后都",
        "永远不要",
        "以后不要",
        "定成规矩",
        "记下来",
        "remember this",
        "from now on",
        "always remember",
        "never do this again",
    ];
    if explicit_phrases.iter().any(|p| lower.contains(p)) {
        return RememberSignal::ExplicitRemember;
    }

    RememberSignal::None
}

/// Generate a time-ordered UUIDv7 string for stable cross-export entity IDs.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Current UTC timestamp in RFC3339 format.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalizes_ssh_https_and_port_git_remotes_identically() {
        let expected = Some("github.com/jevonscode/fuli".to_string());
        assert_eq!(
            canonicalize_git_remote("git@github.com:JevonsCode/fuli.git"),
            expected
        );
        assert_eq!(
            canonicalize_git_remote("https://github.com/JevonsCode/fuli.git/"),
            expected
        );
        assert_eq!(
            canonicalize_git_remote("ssh://git@github.com:22/JevonsCode/fuli"),
            expected
        );
        assert_eq!(
            canonicalize_git_remote("https://token@github.com/JevonsCode/fuli"),
            expected
        );
    }

    #[test]
    fn normalizes_windows_and_unix_paths() {
        assert_eq!(
            normalize_dir_path(r"T:\workspace\fuli\"),
            "t:/workspace/fuli"
        );
        assert_eq!(
            normalize_dir_path("/Users/jevons/fuli/"),
            "/Users/jevons/fuli"
        );
        assert_eq!(
            path_basename(r"T:\workspace\fuli\").as_deref(),
            Some("fuli")
        );
    }

    #[test]
    fn detects_explicit_remember_and_repeat_signals() {
        assert_eq!(
            detect_remember_signal("以后都不加装饰阴影"),
            RememberSignal::ExplicitRemember
        );
        assert_eq!(
            detect_remember_signal("我上次就说过别推 main 分支"),
            RememberSignal::RepeatReminder
        );
        assert_eq!(
            detect_remember_signal("帮我看看这个函数哪里错了"),
            RememberSignal::None
        );
    }
}
