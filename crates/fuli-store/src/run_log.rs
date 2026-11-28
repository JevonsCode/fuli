//! FULI run log: what FULI did for each client turn, step by step.
//!
//! Kept deliberately small. Each step stores a tag, a one-line title and a short detail
//! (<= 600 bytes: counts, IDs, titles), never knowledge bodies or the user's prompt.
//! Old rows are pruned by `prune_run_steps` (default: 14 days or 5000 rows).

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::{FuliStore, StoreResult};

pub const RUN_STEP_DETAIL_MAX_BYTES: usize = 600;
pub const RUN_STEPS_KEEP_ROWS: i64 = 5000;
pub const RUN_STEPS_KEEP_DAYS: i64 = 14;

/// One step of one trace. A trace is one Hook event or one MCP tool call.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunStep {
    pub id: String,
    pub client_id: String,
    pub session_id: String,
    pub turn_seq: i64,
    pub trace_id: String,
    pub step_seq: i64,
    /// `hook` or `mcp`
    pub source: String,
    /// Short machine tag shown as a chip: trigger / project / rules / dedup / inbox /
    /// search / hit / write / return / skip / error.
    pub tag: String,
    pub title: String,
    pub detail: String,
    pub agent_id: Option<String>,
    pub duration_us: i64,
    pub tokens_est: i64,
    pub created_at: String,
}

/// A session as listed in the run log (newest first).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunSessionSummary {
    pub client_id: String,
    pub session_id: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub traces: i64,
    pub steps: i64,
    pub tokens_est: i64,
    pub first_at: String,
    pub last_at: String,
}

fn clip(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

impl FuliStore {
    pub fn insert_run_steps(&self, steps: &[RunStep]) -> StoreResult<()> {
        let mut stmt = self.conn.prepare_cached(
            "INSERT INTO run_steps (id, client_id, session_id, turn_seq, trace_id, step_seq, source,
                tag, title, detail, agent_id, duration_us, tokens_est, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        )?;
        for st in steps {
            stmt.execute(params![
                st.id,
                st.client_id,
                st.session_id,
                st.turn_seq,
                st.trace_id,
                st.step_seq,
                st.source,
                st.tag,
                clip(&st.title, 160),
                clip(&st.detail, RUN_STEP_DETAIL_MAX_BYTES),
                st.agent_id,
                st.duration_us,
                st.tokens_est,
                st.created_at
            ])?;
        }
        Ok(())
    }

    pub fn list_run_sessions(&self, limit: usize) -> StoreResult<Vec<RunSessionSummary>> {
        let mut stmt = self.conn.prepare(
            "SELECT r.client_id, r.session_id,
                    (SELECT agent_id FROM run_steps x WHERE x.client_id = r.client_id
                        AND x.session_id = r.session_id AND x.agent_id IS NOT NULL
                        ORDER BY x.created_at DESC LIMIT 1) AS aid,
                    COUNT(DISTINCT r.trace_id), COUNT(*), COALESCE(SUM(r.tokens_est), 0),
                    MIN(r.created_at), MAX(r.created_at)
             FROM run_steps r
             GROUP BY r.client_id, r.session_id
             ORDER BY MAX(r.created_at) DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit as i64], |row| {
            Ok(RunSessionSummary {
                client_id: row.get(0)?,
                session_id: row.get(1)?,
                agent_id: row.get(2)?,
                agent_name: None,
                traces: row.get(3)?,
                steps: row.get(4)?,
                tokens_est: row.get(5)?,
                first_at: row.get(6)?,
                last_at: row.get(7)?,
            })
        })?;
        let mut out = rows.collect::<Result<Vec<_>, _>>()?;
        for s in &mut out {
            if let Some(aid) = &s.agent_id {
                s.agent_name = self.get_agent(aid)?.map(|a| a.name);
            }
        }
        Ok(out)
    }

    /// Steps of one session in time order (`limit` most recent steps).
    pub fn list_run_steps(
        &self,
        client_id: &str,
        session_id: &str,
        limit: usize,
    ) -> StoreResult<Vec<RunStep>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, client_id, session_id, turn_seq, trace_id, step_seq, source, tag, title,
                    detail, agent_id, duration_us, tokens_est, created_at
             FROM (SELECT rowid AS rid, * FROM run_steps WHERE client_id = ?1 AND session_id = ?2
                   ORDER BY rid DESC LIMIT ?3)
             ORDER BY rid ASC",
        )?;
        let rows = stmt.query_map(params![client_id, session_id, limit as i64], |row| {
            Ok(RunStep {
                id: row.get(0)?,
                client_id: row.get(1)?,
                session_id: row.get(2)?,
                turn_seq: row.get(3)?,
                trace_id: row.get(4)?,
                step_seq: row.get(5)?,
                source: row.get(6)?,
                tag: row.get(7)?,
                title: row.get(8)?,
                detail: row.get(9)?,
                agent_id: row.get(10)?,
                duration_us: row.get(11)?,
                tokens_est: row.get(12)?,
                created_at: row.get(13)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Keep the run log small: drop rows older than `keep_days` and beyond `keep_rows`.
    pub fn prune_run_steps(&self, keep_days: i64, keep_rows: i64) -> StoreResult<usize> {
        let by_age = self.conn.execute(
            "DELETE FROM run_steps WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?1)",
            [format!("-{keep_days} days")],
        )?;
        let by_count = self.conn.execute(
            "DELETE FROM run_steps WHERE id IN (
                SELECT id FROM run_steps ORDER BY created_at DESC, step_seq DESC LIMIT -1 OFFSET ?1)",
            [keep_rows],
        )?;
        Ok(by_age + by_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(trace: &str, seq: i64, tag: &str, at: &str) -> RunStep {
        RunStep {
            id: format!("{trace}-{seq}"),
            client_id: "claude-code".into(),
            session_id: "s1".into(),
            turn_seq: 1,
            trace_id: trace.into(),
            step_seq: seq,
            source: "hook".into(),
            tag: tag.into(),
            title: "x".repeat(400),
            detail: "细".repeat(400),
            agent_id: None,
            duration_us: 10,
            tokens_est: 3,
            created_at: at.into(),
        }
    }

    #[test]
    fn stores_clipped_steps_lists_sessions_and_prunes() {
        let store = FuliStore::open_in_memory().unwrap();
        store
            .insert_run_steps(&[
                step("t1", 1, "trigger", "2026-11-28T01:00:00Z"),
                step("t1", 2, "project", "2026-11-28T01:00:00Z"),
                step("t2", 1, "search", "2026-11-28T01:01:00Z"),
            ])
            .unwrap();
        let steps = store.list_run_steps("claude-code", "s1", 50).unwrap();
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0].tag, "trigger");
        assert!(steps[0].title.chars().count() <= 162, "title clipped");
        assert!(
            steps[0].detail.len() <= RUN_STEP_DETAIL_MAX_BYTES + 3,
            "detail clipped"
        );
        let sessions = store.list_run_sessions(10).unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(
            (
                sessions[0].traces,
                sessions[0].steps,
                sessions[0].tokens_est
            ),
            (2, 3, 9)
        );
        assert_eq!(store.prune_run_steps(36500, 2).unwrap(), 1);
        assert_eq!(
            store.list_run_steps("claude-code", "s1", 50).unwrap().len(),
            2
        );
    }
}

#[cfg(all(test, unix))]
mod symlink_binding_tests {
    use crate::FuliStore;
    use fuli_domain::{AgentResolution, BindingKind, BindingRole};

    #[test]
    fn a_folder_bound_through_a_symlink_matches_its_resolved_path() {
        let base = std::env::temp_dir().join(format!("fuli-symlink-{}", std::process::id()));
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = base.join("link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let store = FuliStore::open_in_memory().unwrap();
        let agent = store.create_agent("Saturn", "", "zh-CN", "").unwrap();
        store
            .bind_agent(
                &agent.id,
                BindingKind::DirPath,
                link.to_str().unwrap(),
                BindingRole::Own,
                "",
            )
            .unwrap();
        let resolved = std::fs::canonicalize(&real).unwrap();
        let (res, _) = store
            .resolve_agent_by_cwd(resolved.to_str().unwrap())
            .unwrap();
        assert!(
            matches!(res, AgentResolution::Matched { .. }),
            "got {res:?}"
        );
        let (res, _) = store.resolve_agent_by_cwd(link.to_str().unwrap()).unwrap();
        assert!(matches!(res, AgentResolution::Matched { .. }));
        let _ = std::fs::remove_dir_all(&base);
    }
}
