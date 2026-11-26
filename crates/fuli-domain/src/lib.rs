pub mod identity;
pub mod model;
pub mod rules;

pub use identity::{
    RememberSignal, canonicalize_git_remote, detect_remember_signal, new_id, normalize_dir_path,
    normalize_name_key, now_rfc3339, path_basename,
};
pub use model::*;
pub use rules::{ResolvedRules, RuleConflict, resolve_rules_and_prefs};
