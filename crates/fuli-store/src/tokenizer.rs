use std::collections::HashSet;

/// Returns true if `c` is a CJK Unified Ideograph or common CJK compatibility character.
pub fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x3040..=0x309F
            | 0x30A0..=0x30FF
            | 0xAC00..=0xD7AF
    )
}

/// Bilingual Rust-side pre-tokenizer for SQLite FTS5 `unicode61`:
/// - Generates overlapping CJK bigrams (`发布流程` -> `发布 布流 流程`) plus unigrams for
///   single-char runs so 2-char Chinese queries (`报错`, `阴影`, `发版`) match cleanly even
///   without an external jieba dictionary.
/// - Preserves exact lowercase ASCII/code/error identifiers (`eperm`, `e_auth_401`, `gpui_kit`)
///   AND splits camelCase / snake_case / kebab-case parts so both `AuthService` and `auth` match.
pub fn tokenize_for_index(text: &str) -> String {
    tokenize_terms(text, true).join(" ")
}

/// Extract clean deduplicated search terms from a user or agent query.
/// For CJK runs of length >= 2, emits bigrams (higher precision than raw unigrams);
/// for length 1, keeps the single CJK char.
pub fn tokenize_query_terms(query: &str) -> Vec<String> {
    tokenize_terms(query, false)
}

fn tokenize_terms(text: &str, include_cjk_unigrams: bool) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    let mut push = |tok: String| {
        if !tok.is_empty() && seen.insert(tok.clone()) {
            out.push(tok);
        }
    };

    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if is_cjk(ch) {
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) {
                i += 1;
            }
            let run = &chars[start..i];
            if run.len() == 1 {
                push(run[0].to_string());
            } else {
                for pair in run.windows(2) {
                    let mut bg = String::with_capacity(8);
                    bg.push(pair[0]);
                    bg.push(pair[1]);
                    push(bg);
                }
                if include_cjk_unigrams {
                    for &c in run {
                        push(c.to_string());
                    }
                }
            }
            continue;
        }

        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
            let start = i;
            while i < chars.len()
                && (chars[i].is_ascii_alphanumeric()
                    || chars[i] == '_'
                    || chars[i] == '-'
                    || chars[i] == '.')
            {
                i += 1;
            }
            let raw: String = chars[start..i].iter().collect();
            let trimmed = raw.trim_matches(|c| c == '.' || c == '-' || c == '_');
            if trimmed.is_empty() {
                continue;
            }

            // Preserve full identifier in lowercase (e.g. `e_auth_401`, `gpui-kit`)
            let full_lower = trimmed.to_lowercase();
            // Convert separators to underscore for FTS5 safe token matching
            let fts_safe = full_lower.replace(['-', '.'], "_");
            push(fts_safe);

            // Also split on `_`, `-`, `.` and CamelCase boundaries
            for part in trimmed.split(['_', '-', '.']) {
                if part.is_empty() {
                    continue;
                }
                let lower_part = part.to_lowercase();
                if lower_part.len() >= 2 || lower_part.chars().all(|c| c.is_ascii_digit()) {
                    push(lower_part);
                }
                for camel_seg in split_camel_case(part) {
                    if camel_seg.len() >= 2 {
                        push(camel_seg);
                    }
                }
            }
            continue;
        }

        i += 1;
    }

    out
}

fn split_camel_case(token: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut cur = String::new();
    let chars: Vec<char> = token.chars().collect();
    for (idx, &ch) in chars.iter().enumerate() {
        let prev_lower = idx > 0 && chars[idx - 1].is_ascii_lowercase();
        let next_lower = idx + 1 < chars.len() && chars[idx + 1].is_ascii_lowercase();
        if ch.is_ascii_uppercase() && !cur.is_empty() && (prev_lower || next_lower) {
            parts.push(cur.to_lowercase());
            cur.clear();
        }
        cur.push(ch);
    }
    if !cur.is_empty() {
        parts.push(cur.to_lowercase());
    }
    parts
}

/// Build an FTS5 `MATCH` expression from query terms using OR across quoted safe tokens.
pub fn build_fts5_match_query(terms: &[String]) -> Option<String> {
    let cleaned: Vec<String> = terms
        .iter()
        .map(|t| t.replace('"', "").trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if cleaned.is_empty() {
        return None;
    }
    Some(
        cleaned
            .into_iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_two_char_chinese_and_exact_error_codes() {
        let idx =
            tokenize_for_index("GPUI 卡片不要加阴影，遇到 EPERM 或 AuthService 报错先检查权限");
        assert!(idx.contains("阴影"));
        assert!(idx.contains("报错"));
        assert!(idx.contains("eperm"));
        assert!(idx.contains("authservice"));
        assert!(idx.contains("auth"));
        assert!(idx.contains("service"));

        let q = tokenize_query_terms("阴影 报错 EPERM");
        assert!(q.contains(&"阴影".to_string()));
        assert!(q.contains(&"报错".to_string()));
        assert!(q.contains(&"eperm".to_string()));
    }

    #[test]
    fn preserves_hyphenated_and_underscored_code_tokens() {
        let q = tokenize_query_terms("gpui-kit E_AUTH_401");
        assert!(q.contains(&"gpui_kit".to_string()));
        assert!(q.contains(&"gpui".to_string()));
        assert!(q.contains(&"e_auth_401".to_string()));
        assert!(q.contains(&"401".to_string()));
    }
}
