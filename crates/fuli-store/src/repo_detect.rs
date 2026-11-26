use std::fs;
use std::path::{Path, PathBuf};

use fuli_domain::{canonicalize_git_remote, normalize_dir_path};

/// Fast zero-subprocess Git repository inspection (< 1ms).
/// Handles standard `.git/` directories AND linked Git worktrees (`.git` file pointing
/// to `<main>/.git/worktrees/<name>` + `commondir`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DetectedRepo {
    pub repo_root: Option<String>,
    pub git_remote_canonical: Option<String>,
    pub branch: Option<String>,
}

pub fn detect_repo_at(cwd: &str) -> DetectedRepo {
    let start = Path::new(cwd);
    if !start.exists() {
        return DetectedRepo::default();
    }

    let mut current = if start.is_file() {
        start.parent().map(Path::to_path_buf)
    } else {
        Some(start.to_path_buf())
    };

    while let Some(dir) = current {
        let dot_git = dir.join(".git");
        if dot_git.exists() {
            let repo_root = Some(normalize_dir_path(&dir.to_string_lossy()));
            let (git_dir, common_dir) = resolve_git_dirs(&dir, &dot_git);
            let branch = git_dir.as_deref().and_then(read_head_branch);
            let git_remote_canonical = common_dir
                .as_deref()
                .or(git_dir.as_deref())
                .and_then(read_origin_remote)
                .and_then(|raw| canonicalize_git_remote(&raw));

            return DetectedRepo {
                repo_root,
                git_remote_canonical,
                branch,
            };
        }
        current = dir.parent().map(Path::to_path_buf);
    }

    DetectedRepo::default()
}

fn resolve_git_dirs(work_dir: &Path, dot_git: &Path) -> (Option<PathBuf>, Option<PathBuf>) {
    if dot_git.is_dir() {
        return (Some(dot_git.to_path_buf()), Some(dot_git.to_path_buf()));
    }
    let Ok(content) = fs::read_to_string(dot_git) else {
        return (None, None);
    };
    let Some(raw_gitdir) = content
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))
        .map(str::trim)
    else {
        return (None, None);
    };

    let git_dir_path = Path::new(raw_gitdir);
    let resolved_git_dir = if git_dir_path.is_absolute() {
        git_dir_path.to_path_buf()
    } else {
        work_dir.join(git_dir_path)
    };

    // Linked worktree has a `commondir` file pointing back to the main `.git` folder.
    let commondir_file = resolved_git_dir.join("commondir");
    let common_dir = if let Ok(rel) = fs::read_to_string(&commondir_file) {
        let trimmed = rel.trim();
        let p = Path::new(trimmed);
        if p.is_absolute() {
            Some(p.to_path_buf())
        } else {
            Some(resolved_git_dir.join(p))
        }
    } else {
        Some(resolved_git_dir.clone())
    };

    (Some(resolved_git_dir), common_dir)
}

fn read_head_branch(git_dir: &Path) -> Option<String> {
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let line = head.lines().next()?.trim();
    if let Some(ref_path) = line.strip_prefix("ref:") {
        let trimmed = ref_path.trim();
        return Some(
            trimmed
                .strip_prefix("refs/heads/")
                .unwrap_or(trimmed)
                .to_string(),
        );
    }
    // Detached HEAD: return short 8-char SHA
    Some(line.chars().take(8).collect())
}

fn read_origin_remote(common_dir: &Path) -> Option<String> {
    let cfg = fs::read_to_string(common_dir.join("config")).ok()?;
    let mut in_origin = false;
    let mut first_remote_url: Option<String> = None;
    let mut in_any_remote = false;

    for raw_line in cfg.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            let header = &line[1..line.len() - 1];
            in_origin = header.eq_ignore_ascii_case("remote \"origin\"");
            in_any_remote = header.to_ascii_lowercase().starts_with("remote \"");
            continue;
        }
        if let Some((k, v)) = line.split_once('=')
            && k.trim().eq_ignore_ascii_case("url")
        {
            let url = v.trim().to_string();
            if in_origin {
                return Some(url);
            }
            if in_any_remote && first_remote_url.is_none() {
                first_remote_url = Some(url);
            }
        }
    }
    first_remote_url
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("fuli-git-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn detects_standard_repo_and_linked_worktree_to_same_remote() {
        let root = make_temp_dir("wt");
        let main_repo = root.join("main-repo");
        let main_git = main_repo.join(".git");
        let wt_git = main_git.join("worktrees").join("feat-next");
        let wt_dir = root.join("wt-feat");

        fs::create_dir_all(&wt_git).unwrap();
        fs::create_dir_all(wt_dir.join("nested")).unwrap();

        fs::write(
            main_git.join("config"),
            "[remote \"origin\"]\n\turl = git@github.com:JevonsCode/fuli.git\n",
        )
        .unwrap();
        fs::write(main_git.join("HEAD"), "ref: refs/heads/next\n").unwrap();

        fs::write(wt_git.join("commondir"), "../..\n").unwrap();
        fs::write(wt_git.join("HEAD"), "ref: refs/heads/next/kernel\n").unwrap();
        fs::write(
            wt_dir.join(".git"),
            format!("gitdir: {}\n", wt_git.display()),
        )
        .unwrap();

        let main_detected = detect_repo_at(&main_repo.to_string_lossy());
        let wt_detected = detect_repo_at(&wt_dir.join("nested").to_string_lossy());

        assert_eq!(
            main_detected.git_remote_canonical.as_deref(),
            Some("github.com/jevonscode/fuli")
        );
        assert_eq!(
            wt_detected.git_remote_canonical.as_deref(),
            Some("github.com/jevonscode/fuli")
        );
        assert_eq!(main_detected.branch.as_deref(), Some("next"));
        assert_eq!(wt_detected.branch.as_deref(), Some("next/kernel"));

        let _ = fs::remove_dir_all(&root);
    }
}
