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
    /// MCP tool name or Hook event (`prompt`, `pre_compact`, `stop`).
    #[serde(default)]
    pub tool: String,
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
                tag, title, detail, agent_id, duration_us, tokens_est, created_at, tool)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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
                st.created_at,
                st.tool
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
        let q = RunLogQuery {
            client: Some(client_id.to_string()),
            session: Some(session_id.to_string()),
            limit,
            ..Default::default()
        };
        Ok(self.search_run_log(&q)?.steps)
    }

    /// Multi-dimensional run-log search. A trace (one Hook event / MCP call) matches when
    /// any of its steps matches; whole matching traces are returned so each reads in full.
    pub fn search_run_log(&self, q: &RunLogQuery) -> StoreResult<RunLogResult> {
        let (where_sql, binds) = q.where_clause();
        let limit = q.limit.clamp(1, 2000) as i64;
        let sql = format!(
            "SELECT {STEP_COLS} FROM run_steps
             WHERE trace_id IN (
                SELECT trace_id FROM run_steps WHERE {where_sql}
                GROUP BY trace_id ORDER BY MAX(rowid) DESC LIMIT {limit})
             ORDER BY rowid ASC"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let steps = stmt
            .query_map(rusqlite::params_from_iter(binds.iter()), row_to_step)?
            .collect::<Result<Vec<_>, _>>()?;
        let total_traces: i64 = self.conn.query_row(
            &format!("SELECT COUNT(DISTINCT trace_id) FROM run_steps WHERE {where_sql}"),
            rusqlite::params_from_iter(binds.iter()),
            |r| r.get(0),
        )?;
        Ok(RunLogResult {
            steps,
            total_traces,
        })
    }

    /// Values each filter can take right now, with counts (for filter chips).
    pub fn run_log_facets(&self) -> StoreResult<RunLogFacets> {
        let count = |col: &str| -> StoreResult<Vec<FacetValue>> {
            let mut stmt = self.conn.prepare(&format!(
                "SELECT {col}, COUNT(DISTINCT trace_id) FROM run_steps
                 WHERE {col} IS NOT NULL AND {col} != '' GROUP BY {col} ORDER BY 2 DESC LIMIT 40"
            ))?;
            let rows = stmt.query_map([], |r| {
                Ok(FacetValue {
                    value: r.get(0)?,
                    label: None,
                    traces: r.get(1)?,
                })
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        };
        let mut agents = count("agent_id")?;
        for a in &mut agents {
            a.label = self.get_agent(&a.value)?.map(|x| x.name);
        }
        Ok(RunLogFacets {
            clients: count("client_id")?,
            agents,
            tags: count("tag")?,
            tools: count("tool")?,
            sources: count("source")?,
        })
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

const STEP_COLS: &str = "id, client_id, session_id, turn_seq, trace_id, step_seq, source, tag, \
    title, detail, agent_id, duration_us, tokens_est, created_at, tool";

fn row_to_step(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunStep> {
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
        tool: row.get(14)?,
    })
}

/// Run-log filters. Every field is optional; set fields are ANDed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RunLogQuery {
    /// Keyword in a step's title or detail (project names, queries, hit titles, errors…).
    pub text: Option<String>,
    pub client: Option<String>,
    pub session: Option<String>,
    pub agent_id: Option<String>,
    /// `hook` or `mcp`
    pub source: Option<String>,
    pub tag: Option<String>,
    pub tool: Option<String>,
    /// RFC 3339 lower / upper bounds on `created_at`.
    pub since: Option<String>,
    pub until: Option<String>,
    /// Only traces that contain an `error` step.
    pub errors_only: bool,
    /// Max traces returned (newest first).
    pub limit: usize,
}

impl RunLogQuery {
    fn where_clause(&self) -> (String, Vec<String>) {
        let mut parts: Vec<String> = vec!["1=1".into()];
        let mut binds: Vec<String> = Vec::new();
        let mut eq = |col: &str, v: &Option<String>, parts: &mut Vec<String>| {
            if let Some(v) = v.as_ref().map(|v| v.trim()).filter(|v| !v.is_empty()) {
                binds.push(v.to_string());
                parts.push(format!("{col} = ?{}", binds.len()));
            }
        };
        eq("client_id", &self.client, &mut parts);
        eq("session_id", &self.session, &mut parts);
        eq("agent_id", &self.agent_id, &mut parts);
        eq("source", &self.source, &mut parts);
        eq("tag", &self.tag, &mut parts);
        eq("tool", &self.tool, &mut parts);
        if let Some(t) = self
            .text
            .as_ref()
            .map(|t| t.trim())
            .filter(|t| !t.is_empty())
        {
            let escaped = t
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_");
            binds.push(format!("%{escaped}%"));
            let n = binds.len();
            parts.push(format!(
                "(title LIKE ?{n} ESCAPE '\\' OR detail LIKE ?{n} ESCAPE '\\')"
            ));
        }
        if let Some(v) = self.since.as_ref().filter(|v| !v.is_empty()) {
            binds.push(v.clone());
            parts.push(format!("created_at >= ?{}", binds.len()));
        }
        if let Some(v) = self.until.as_ref().filter(|v| !v.is_empty()) {
            binds.push(v.clone());
            parts.push(format!("created_at <= ?{}", binds.len()));
        }
        if self.errors_only {
            parts.push("trace_id IN (SELECT trace_id FROM run_steps WHERE tag = 'error')".into());
        }
        (parts.join(" AND "), binds)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunLogResult {
    pub steps: Vec<RunStep>,
    /// How many traces match in total (the result may be capped by `limit`).
    pub total_traces: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FacetValue {
    pub value: String,
    /// Display name where the raw value is an id (projects).
    pub label: Option<String>,
    pub traces: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunLogFacets {
    pub clients: Vec<FacetValue>,
    pub agents: Vec<FacetValue>,
    pub tags: Vec<FacetValue>,
    pub tools: Vec<FacetValue>,
    pub sources: Vec<FacetValue>,
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
            tool: String::new(),
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

#[cfg(test)]
mod search_tests {
    use super::*;

    fn st(
        trace: &str,
        seq: i64,
        client: &str,
        tool: &str,
        tag: &str,
        title: &str,
        at: &str,
    ) -> RunStep {
        RunStep {
            id: format!("{trace}-{seq}"),
            client_id: client.into(),
            session_id: format!("{client}-s"),
            turn_seq: 1,
            trace_id: trace.into(),
            step_seq: seq,
            source: if tool == "prompt" { "hook" } else { "mcp" }.into(),
            tool: tool.into(),
            tag: tag.into(),
            title: title.into(),
            detail: String::new(),
            agent_id: None,
            duration_us: 1,
            tokens_est: 1,
            created_at: at.into(),
        }
    }

    #[test]
    fn filters_combine_and_return_whole_traces() {
        let store = FuliStore::open_in_memory().unwrap();
        store
            .insert_run_steps(&[
                st(
                    "a",
                    1,
                    "claude-code",
                    "prompt",
                    "trigger",
                    "用户发了一条消息",
                    "2026-11-28T01:00:00Z",
                ),
                st(
                    "a",
                    2,
                    "claude-code",
                    "prompt",
                    "project",
                    "识别到项目：Saturn",
                    "2026-11-28T01:00:00Z",
                ),
                st(
                    "b",
                    1,
                    "codex",
                    "search_knowledge",
                    "trigger",
                    "模型调用工具",
                    "2026-11-28T02:00:00Z",
                ),
                st(
                    "b",
                    2,
                    "codex",
                    "search_knowledge",
                    "hit",
                    "命中 5 条（来自 Saturn）",
                    "2026-11-28T02:00:00Z",
                ),
                st(
                    "c",
                    1,
                    "codex",
                    "save_rule_or_preference",
                    "trigger",
                    "模型调用工具",
                    "2026-11-28T03:00:00Z",
                ),
                st(
                    "c",
                    2,
                    "codex",
                    "save_rule_or_preference",
                    "error",
                    "调用失败 100%_done",
                    "2026-11-28T03:00:00Z",
                ),
            ])
            .unwrap();
        let q = |f: &dyn Fn(&mut RunLogQuery)| {
            let mut q = RunLogQuery {
                limit: 50,
                ..Default::default()
            };
            f(&mut q);
            let r = store.search_run_log(&q).unwrap();
            let mut traces: Vec<String> = r.steps.iter().map(|s| s.trace_id.clone()).collect();
            traces.dedup();
            (traces, r.total_traces)
        };
        // Text hits a later step, yet the whole trace comes back (trigger included).
        assert_eq!(q(&|q| q.text = Some("Saturn".into())).0, ["a", "b"]);
        assert_eq!(
            store
                .search_run_log(&RunLogQuery {
                    text: Some("命中".into()),
                    limit: 9,
                    ..Default::default()
                })
                .unwrap()
                .steps
                .len(),
            2
        );
        assert_eq!(q(&|q| q.client = Some("codex".into())).0, ["b", "c"]);
        assert_eq!(q(&|q| q.tool = Some("search_knowledge".into())).0, ["b"]);
        assert_eq!(q(&|q| q.tag = Some("project".into())).0, ["a"]);
        assert_eq!(q(&|q| q.source = Some("hook".into())).0, ["a"]);
        assert_eq!(q(&|q| q.errors_only = true).0, ["c"]);
        assert_eq!(
            q(&|q| {
                q.client = Some("codex".into());
                q.text = Some("Saturn".into());
            })
            .0,
            ["b"]
        );
        assert_eq!(
            q(&|q| q.since = Some("2026-11-28T02:30:00Z".into())).0,
            ["c"]
        );
        // LIKE wildcards in user text are literal.
        assert_eq!(q(&|q| q.text = Some("100%_".into())).0, ["c"]);
        assert!(q(&|q| q.text = Some("%".into())).0.len() <= 1);
        // limit caps traces, total still counts all matches.
        let (t, total) = q(&|q| {
            q.client = Some("codex".into());
            q.limit = 1;
        });
        assert_eq!((t, total), (vec!["c".to_string()], 2));

        let f = store.run_log_facets().unwrap();
        assert_eq!(
            f.clients
                .iter()
                .map(|c| (c.value.as_str(), c.traces))
                .collect::<Vec<_>>(),
            [("codex", 2), ("claude-code", 1)]
        );
        assert!(f.tools.iter().any(|t| t.value == "search_knowledge"));
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
