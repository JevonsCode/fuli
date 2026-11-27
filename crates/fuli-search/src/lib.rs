use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use fuli_domain::{AuthorizedKb, KbItemStatus, KbItemType};
use fuli_store::{
    EmbeddingRow, FuliStore, StoreResult, build_fts5_match_query, tokenize_query_terms,
};
use serde::{Deserialize, Serialize};

pub const DEFAULT_BYTE_BUDGET: usize = 4096;
pub const DEFAULT_LIMIT: usize = 8;
pub const DEFAULT_VECTOR_IDLE_TTL_SECS: u64 = 60;

/// Optional on-demand embedding provider trait (keeps `fuli-context` zero-model by default;
/// adapters for local ONNX / Ollama / OpenAI-compatible embeddings plug in here).
pub trait EmbeddingProvider: Send + Sync {
    fn model_id(&self) -> &str;
    fn embed_query(&self, query: &str) -> Option<Vec<f32>>;
}

/// On-demand in-memory vector cache with automatic idle eviction (default 60s),
/// ensuring zero idle RAM overhead when semantic search is not actively used.
#[derive(Debug, Default)]
pub struct IdleUnloadVectorCache {
    inner: Mutex<VectorCacheInner>,
}

#[derive(Debug, Default)]
struct VectorCacheInner {
    rows: Vec<EmbeddingRow>,
    loaded_kb_sig: String,
    last_used: Option<Instant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VectorCacheStats {
    pub loaded: bool,
    pub vector_count: usize,
    pub approx_bytes: usize,
    pub idle_secs: Option<u64>,
}

impl IdleUnloadVectorCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn load_authorized(
        &self,
        store: &FuliStore,
        kb_ids: &[String],
    ) -> StoreResult<Vec<EmbeddingRow>> {
        let mut sorted = kb_ids.to_vec();
        sorted.sort();
        let sig = sorted.join(",");
        let mut guard = self.inner.lock().expect("vector cache lock");
        if guard.loaded_kb_sig != sig || guard.last_used.is_none() {
            guard.rows = store.load_embeddings_for_kbs(kb_ids)?;
            guard.loaded_kb_sig = sig;
        }
        guard.last_used = Some(Instant::now());
        Ok(guard.rows.clone())
    }

    /// Release all cached vectors back to the OS if idle for >= `ttl`.
    pub fn evict_if_idle(&self, ttl: Duration) -> bool {
        let mut guard = self.inner.lock().expect("vector cache lock");
        if let Some(last) = guard.last_used
            && last.elapsed() >= ttl
        {
            guard.rows.clear();
            guard.rows.shrink_to_fit();
            guard.loaded_kb_sig.clear();
            guard.last_used = None;
            return true;
        }
        false
    }

    pub fn stats(&self) -> VectorCacheStats {
        let guard = self.inner.lock().expect("vector cache lock");
        let approx_bytes: usize = guard.rows.iter().map(|r| r.vector.len() * 4 + 64).sum();
        VectorCacheStats {
            loaded: !guard.rows.is_empty(),
            vector_count: guard.rows.len(),
            approx_bytes,
            idle_secs: guard.last_used.map(|t| t.elapsed().as_secs()),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub query: String,
    /// Optional batch of 1..=6 focused queries merged & deduplicated by best calibrated score.
    pub queries: Vec<String>,
    pub agent_id: Option<String>,
    pub kb_id: Option<String>,
    pub item_types: Vec<KbItemType>,
    pub limit: Option<usize>,
    pub byte_budget: Option<usize>,
    pub include_proposals: bool,
    pub query_vector: Option<Vec<f32>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: String,
    pub kb_id: String,
    pub kb_name: String,
    pub hop: u8,
    pub item_type: KbItemType,
    pub status: KbItemStatus,
    pub lang: String,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub context_summary: String,
    pub rev: i64,
    pub score: f64,
    #[serde(skip_serializing_if = "is_false")]
    pub needs_review: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Compact overflow pointer so high-scoring secondary hits outside `byte_budget`
/// remain discoverable by exact ID + revision without wasting tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoreTitleRef {
    pub id: String,
    pub rev: i64,
    pub kb_name: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BudgetInfo {
    pub limit_bytes: usize,
    pub used_bytes: usize,
    pub complete: bool,
    pub returned: usize,
    pub total_matched: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SearchResponse {
    pub query: String,
    pub hits: Vec<SearchHit>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub more_titles: Vec<MoreTitleRef>,
    pub budget: BudgetInfo,
    pub authorized_kb_count: usize,
}

/// 4-Stage Authorized Bilingual Hybrid Search Engine (supports single or up to 6 merged queries).
pub fn search_knowledge(
    store: &FuliStore,
    opts: &SearchOptions,
    embedder: Option<&dyn EmbeddingProvider>,
) -> StoreResult<SearchResponse> {
    search_knowledge_with_cache(store, opts, embedder, None)
}

pub fn search_knowledge_with_cache(
    store: &FuliStore,
    opts: &SearchOptions,
    embedder: Option<&dyn EmbeddingProvider>,
    vector_cache: Option<&IdleUnloadVectorCache>,
) -> StoreResult<SearchResponse> {
    let limit = opts.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, 50);
    let byte_budget = opts.byte_budget.unwrap_or(DEFAULT_BYTE_BUDGET).max(256);

    // Collect 1..=6 normalized queries (supports either `queries[]` or single `query`)
    let mut query_list: Vec<String> = opts
        .queries
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(6)
        .collect();
    if query_list.is_empty() && !opts.query.trim().is_empty() {
        query_list.push(opts.query.trim().to_string());
    }
    let display_query = if !opts.query.trim().is_empty() {
        opts.query.trim().to_string()
    } else {
        query_list.join(" | ")
    };

    // Stage 1: Resolve authorized KB whitelist first (0% unauthorized leaks guaranteed!)
    let auth_kbs = resolve_authorized_kbs(store, opts.agent_id.as_deref(), opts.kb_id.as_deref())?;
    let auth_map: HashMap<String, AuthorizedKb> = auth_kbs
        .iter()
        .cloned()
        .map(|k| (k.kb_id.clone(), k))
        .collect();

    if auth_kbs.is_empty()
        || (query_list.is_empty() && opts.query_vector.is_none() && embedder.is_none())
    {
        return Ok(SearchResponse {
            query: display_query,
            hits: Vec::new(),
            more_titles: Vec::new(),
            budget: BudgetInfo {
                limit_bytes: byte_budget,
                used_bytes: 0,
                complete: true,
                returned: 0,
                total_matched: 0,
            },
            authorized_kb_count: auth_kbs.len(),
        });
    }

    let active_agent_name = opts
        .agent_id
        .as_deref()
        .and_then(|aid| store.get_agent(aid).ok().flatten())
        .map(|a| a.name);
    let own_name_terms: HashSet<String> = active_agent_name
        .as_deref()
        .map(|n| tokenize_query_terms(n).into_iter().collect())
        .unwrap_or_default();

    let combined_lower = query_list.join(" ").to_lowercase();
    let named_kb_ids: HashSet<String> = auth_kbs
        .iter()
        .filter(|k| {
            let clean_name = k.kb_name.trim_end_matches("知识库").trim().to_lowercase();
            !clean_name.is_empty() && combined_lower.contains(&clean_name)
        })
        .map(|k| k.kb_id.clone())
        .collect();

    let kb_ids: Vec<String> = auth_kbs.iter().map(|k| k.kb_id.clone()).collect();

    // Stage 2: Authorized FTS5 BM25 across all queries (merge by max calibrated score per item!)
    let mut merged_lex: HashMap<String, f64> = HashMap::new();
    for q in &query_list {
        let raw_terms = tokenize_query_terms(q);
        if raw_terms.is_empty() {
            continue;
        }
        let discriminating: Vec<String> = raw_terms
            .iter()
            .filter(|t| !own_name_terms.contains(*t))
            .cloned()
            .collect();
        let fts_terms = if !discriminating.is_empty() {
            &discriminating
        } else {
            &raw_terms
        };
        for (id, sc) in run_authorized_fts5(store, &kb_ids, fts_terms)? {
            merged_lex
                .entry(id)
                .and_modify(|prev| {
                    if sc > *prev {
                        *prev = sc;
                    }
                })
                .or_insert(sc);
        }
    }
    let mut lexical_scores: Vec<(String, f64)> = merged_lex.into_iter().collect();
    lexical_scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    // Stage 3: Optional authorized vector cosine scan (uses IdleUnloadVectorCache when supplied)
    let query_vec = opts
        .query_vector
        .clone()
        .or_else(|| embedder.and_then(|p| p.embed_query(&display_query)));
    let vector_scores = if let Some(ref qv) = query_vec {
        run_authorized_vector_scan(store, &kb_ids, qv, vector_cache)?
    } else {
        Vec::new()
    };

    // Merge lexical & vector candidates using calibrated score + RRF when both exist
    let mut candidate_scores: HashMap<String, f64> = HashMap::new();
    let lex_ranks: HashMap<String, (usize, f64)> = lexical_scores
        .iter()
        .enumerate()
        .map(|(idx, (id, sc))| (id.clone(), (idx + 1, *sc)))
        .collect();
    let vec_ranks: HashMap<String, (usize, f64)> = vector_scores
        .iter()
        .enumerate()
        .map(|(idx, (id, sc))| (id.clone(), (idx + 1, *sc)))
        .collect();

    let all_ids: HashSet<String> = lex_ranks.keys().chain(vec_ranks.keys()).cloned().collect();
    let has_vector = !vec_ranks.is_empty();

    for id in all_ids {
        let score = if has_vector {
            let rrf_lex = lex_ranks
                .get(&id)
                .map(|(r, _)| 1.0 / (60.0 + *r as f64))
                .unwrap_or(0.0);
            let rrf_vec = vec_ranks
                .get(&id)
                .map(|(r, sim)| (1.0 / (60.0 + *r as f64)) * (0.5 + 0.5 * sim.clamp(0.0, 1.0)))
                .unwrap_or(0.0);
            (rrf_lex + rrf_vec) * 100.0
        } else {
            lex_ranks.get(&id).map(|(_, s)| *s).unwrap_or(0.0)
        };
        candidate_scores.insert(id, score);
    }

    // Stage 4: Hydrate, filter item_types, child stable_key override, compounding boost,
    // needs_review -70% penalty, and strict score-ordered byte budget packing!
    let mut hydrated = Vec::new();
    for (item_id, base_score) in candidate_scores {
        let Some(item) = store.get_kb_item(&item_id)? else {
            continue;
        };
        if item.status == KbItemStatus::Deprecated {
            continue;
        }
        if item.status == KbItemStatus::Proposal && !opts.include_proposals {
            continue;
        }
        if !opts.item_types.is_empty() && !opts.item_types.contains(&item.item_type) {
            continue;
        }
        let Some(auth) = auth_map.get(&item.kb_id) else {
            continue;
        };

        let hop_decay = match auth.hop {
            0 => 1.0,
            1 => 0.85,
            _ => 0.72,
        };
        let named_kb_mult = if !named_kb_ids.is_empty() {
            if named_kb_ids.contains(&item.kb_id) {
                1.45
            } else {
                0.70
            }
        } else {
            1.0
        };
        let compounding_boost = 1.0
            + 0.08 * (1.0 + item.helpful_count.max(0) as f64).ln()
            + 0.03 * (1.0 + item.reuse_count.max(0) as f64).ln();
        let review_penalty = if item.needs_review { 0.30 } else { 1.0 };
        let status_factor = match item.status {
            KbItemStatus::Confirmed => 1.0,
            KbItemStatus::Proposal => 0.75,
            KbItemStatus::Deprecated => 0.0,
        };

        let final_score = base_score
            * hop_decay
            * auth.weight.clamp(0.2, 2.0)
            * named_kb_mult
            * compounding_boost
            * review_penalty
            * status_factor;

        hydrated.push((item, auth, final_score));
    }

    let mut best_hop_by_stable_key: HashMap<String, u8> = HashMap::new();
    for (item, auth, _) in &hydrated {
        if let Some(ref sk) = item.stable_key {
            let entry = best_hop_by_stable_key.entry(sk.clone()).or_insert(auth.hop);
            if auth.hop < *entry {
                *entry = auth.hop;
            }
        }
    }

    let mut ranked: Vec<SearchHit> = hydrated
        .into_iter()
        .filter(|(item, auth, _)| match &item.stable_key {
            Some(sk) => best_hop_by_stable_key
                .get(sk)
                .is_none_or(|&best_hop| auth.hop <= best_hop),
            None => true,
        })
        .map(|(item, auth, score)| SearchHit {
            id: item.id,
            kb_id: item.kb_id,
            kb_name: auth.kb_name.clone(),
            hop: auth.hop,
            item_type: item.item_type,
            status: item.status,
            lang: item.lang,
            title: item.title,
            body: item.body,
            context_summary: item.context_summary,
            rev: item.revision,
            score: (score * 1000.0).round() / 1000.0,
            needs_review: item.needs_review,
        })
        .collect();

    ranked.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.hop.cmp(&b.hop))
            .then_with(|| a.id.cmp(&b.id))
    });

    let total_matched = ranked.len();
    let mut hits = Vec::new();
    let mut more_titles = Vec::new();
    let mut used_bytes = 0usize;

    for hit in ranked {
        let est_bytes = serde_json::to_vec(&hit).map(|v| v.len()).unwrap_or(256);
        let fits_count = hits.len() < limit;
        let fits_budget = used_bytes + est_bytes <= byte_budget || hits.is_empty();
        if fits_count && fits_budget {
            used_bytes += est_bytes;
            hits.push(hit);
        } else if more_titles.len() < 10 {
            more_titles.push(MoreTitleRef {
                id: hit.id,
                rev: hit.rev,
                kb_name: hit.kb_name,
                title: hit.title,
            });
        }
    }

    let complete = hits.len() == total_matched;
    Ok(SearchResponse {
        query: display_query,
        budget: BudgetInfo {
            limit_bytes: byte_budget,
            used_bytes,
            complete,
            returned: hits.len(),
            total_matched,
        },
        hits,
        more_titles,
        authorized_kb_count: auth_kbs.len(),
    })
}

fn resolve_authorized_kbs(
    store: &FuliStore,
    agent_id: Option<&str>,
    kb_id: Option<&str>,
) -> StoreResult<Vec<AuthorizedKb>> {
    if let Some(kid) = kb_id {
        if let Some(kb) = store.get_kb(kid)? {
            return Ok(vec![AuthorizedKb {
                kb_id: kb.id,
                kb_name: kb.name,
                hop: 0,
                weight: 1.0,
            }]);
        }
        return Ok(Vec::new());
    }
    if let Some(aid) = agent_id {
        return store.authorized_kbs_for_agent(aid);
    }
    Ok(store
        .list_kbs()?
        .into_iter()
        .map(|kb| AuthorizedKb {
            kb_id: kb.id,
            kb_name: kb.name,
            hop: 0,
            weight: 1.0,
        })
        .collect())
}

fn run_authorized_fts5(
    store: &FuliStore,
    kb_ids: &[String],
    terms: &[String],
) -> StoreResult<Vec<(String, f64)>> {
    let Some(match_expr) = build_fts5_match_query(terms) else {
        return Ok(Vec::new());
    };
    if kb_ids.is_empty() {
        return Ok(Vec::new());
    }

    let placeholders = vec!["?"; kb_ids.len()].join(",");
    let sql = format!(
        "SELECT item_id, -bm25(kb_items_fts, 0.0, 0.0, 3.0, 2.5, 1.5, 1.0) AS lex_score
         FROM kb_items_fts
         WHERE kb_items_fts MATCH ?1
           AND kb_id IN ({placeholders})
         ORDER BY lex_score DESC
         LIMIT 60"
    );

    let mut stmt = store.connection().prepare(&sql)?;
    let mut bind_vals: Vec<String> = Vec::with_capacity(kb_ids.len() + 1);
    bind_vals.push(match_expr);
    bind_vals.extend(kb_ids.iter().cloned());
    let params_refs: Vec<&dyn rusqlite::ToSql> = bind_vals
        .iter()
        .map(|s| s as &dyn rusqlite::ToSql)
        .collect();

    let rows = stmt.query_map(params_refs.as_slice(), |row| {
        let id: String = row.get(0)?;
        let raw_score: f64 = row.get(1)?;
        Ok((id, raw_score.max(0.05) + 0.5))
    })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

fn run_authorized_vector_scan(
    store: &FuliStore,
    kb_ids: &[String],
    query_vec: &[f32],
    cache: Option<&IdleUnloadVectorCache>,
) -> StoreResult<Vec<(String, f64)>> {
    let rows = if let Some(c) = cache {
        c.load_authorized(store, kb_ids)?
    } else {
        store.load_embeddings_for_kbs(kb_ids)?
    };
    let mut scored: Vec<(String, f64)> = rows
        .into_iter()
        .filter_map(|row| {
            let sim = cosine_similarity(query_vec, &row.vector);
            if sim > 0.25 {
                Some((row.item_id, sim))
            } else {
                None
            }
        })
        .collect();
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    scored.truncate(40);
    Ok(scored)
}

pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.is_empty() || a.len() != b.len() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (&x, &y) in a.iter().zip(b.iter()) {
        let xf = f64::from(x);
        let yf = f64::from(y);
        dot += xf * yf;
        norm_a += xf * xf;
        norm_b += yf * yf;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 { 0.0 } else { dot / denom }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fuli_domain::{HumanFeedback, KbItemStatus, KbItemType, KbLinkType, LinkAuthority};
    use fuli_store::UpsertKbItemInput;

    fn add_item(
        store: &FuliStore,
        kb_id: &str,
        item_type: KbItemType,
        lang: &str,
        title: &str,
        body: &str,
        aliases: Vec<&str>,
    ) -> String {
        store
            .upsert_kb_item(UpsertKbItemInput {
                id: None,
                kb_id: kb_id.into(),
                stable_key: None,
                item_type,
                status: KbItemStatus::Confirmed,
                lang: lang.into(),
                translation_of_id: None,
                title: title.into(),
                body: body.into(),
                context_summary: String::new(),
                aliases: aliases.into_iter().map(ToOwned::to_owned).collect(),
                evidence: serde_json::json!({}),
                change_reason: "seed".into(),
                changed_by: "test".into(),
            })
            .unwrap()
            .id
    }

    #[test]
    fn bilingual_four_suite_recall_and_zero_unauthorized_leaks() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent_a = store.create_agent("潮池账本", "", "zh-CN", "").unwrap();
        let kb_a = store.primary_kb_for_agent(&agent_a.id).unwrap().unwrap();
        let kb_shared = store.create_kb("灯笼鱼官网", "", "en-US", false).unwrap();
        let kb_secret = store.create_kb("未授权保密库", "", "zh-CN", false).unwrap();

        store
            .upsert_kb_link(
                &kb_a.id,
                &kb_shared.id,
                KbLinkType::Cites,
                LinkAuthority::HumanConfirmed,
                0.95,
                "跨项目发布参考",
            )
            .unwrap();

        let zh_shadow_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Fact,
            "zh-CN",
            "卡片阴影规范",
            "所有列表卡片禁止装饰性阴影，只保留 1px 细边框。",
            vec!["box shadow", "卡片边框"],
        );
        let en_runbook_id = add_item(
            &store,
            &kb_shared.id,
            KbItemType::Runbook,
            "en-US",
            "Production Release Runbook",
            "Run cargo test --workspace and verify dual-OS CI before tagging.",
            vec!["发版流程", "上线步骤"],
        );
        let zh_error_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Experience,
            "zh-CN",
            "预发布环境 EPERM 报错排查",
            "遇到 EPERM 报错先检查端口 8443 权限与命名管道占用。",
            vec!["staging permission error"],
        );
        let secret_id = add_item(
            &store,
            &kb_secret.id,
            KbItemType::Fact,
            "zh-CN",
            "未授权发版流程与阴影秘密",
            "发版流程 阴影 EPERM Production Release Runbook",
            vec!["发版流程", "release runbook"],
        );
        let vec_en_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Runbook,
            "en-US",
            "On-call Rotation Policy",
            "Primary responder acknowledges incidents within 15 minutes.",
            vec![],
        );
        store
            .upsert_embedding(&vec_en_id, "test-embed", &[0.9, 0.1, 0.0, 0.0])
            .unwrap();
        store
            .upsert_embedding(&secret_id, "test-embed", &[1.0, 0.0, 0.0, 0.0])
            .unwrap();

        let r1 = search_knowledge(
            &store,
            &SearchOptions {
                query: "阴影".into(),
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(r1.hits[0].id, zh_shadow_id);
        assert!(r1.hits.iter().all(|h| h.id != secret_id));

        let r2 = search_knowledge(
            &store,
            &SearchOptions {
                query: "Production Release Runbook".into(),
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(r2.hits[0].id, en_runbook_id);

        let r3a = search_knowledge(
            &store,
            &SearchOptions {
                query: "发版流程".into(),
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(r3a.hits[0].id, en_runbook_id);

        let cache = IdleUnloadVectorCache::new();
        let r3b = search_knowledge_with_cache(
            &store,
            &SearchOptions {
                query: "值班制度".into(),
                agent_id: Some(agent_a.id.clone()),
                query_vector: Some(vec![0.95, 0.1, 0.0, 0.0]),
                ..Default::default()
            },
            None,
            Some(&cache),
        )
        .unwrap();
        assert_eq!(r3b.hits[0].id, vec_en_id);
        assert!(r3b.hits.iter().all(|h| h.id != secret_id));
        assert!(cache.stats().loaded);
        assert!(cache.evict_if_idle(Duration::ZERO));
        assert!(!cache.stats().loaded);
        assert_eq!(cache.stats().approx_bytes, 0);

        let r4 = search_knowledge(
            &store,
            &SearchOptions {
                query: "staging permission error".into(),
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(r4.hits[0].id, zh_error_id);
    }

    #[test]
    fn multi_query_merge_item_type_filter_and_budget_packing() {
        let store = FuliStore::open_in_memory().unwrap();
        let agent_a = store.create_agent("潮池账本", "", "zh-CN", "").unwrap();
        let kb_a = store.primary_kb_for_agent(&agent_a.id).unwrap().unwrap();
        let kb_b = store.create_kb("灯笼鱼官网", "", "zh-CN", false).unwrap();
        store
            .upsert_kb_link(
                &kb_a.id,
                &kb_b.id,
                KbLinkType::Cites,
                LinkAuthority::HumanConfirmed,
                1.0,
                "ref",
            )
            .unwrap();

        let stale_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Runbook,
            "zh-CN",
            "潮池账本 发布流程（旧）",
            "潮池账本 发布流程 旧命令 deploy-old",
            vec![],
        );
        let fresh_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Runbook,
            "zh-CN",
            "潮池账本 发布流程（新）",
            "潮池账本 发布流程 新命令 cargo release",
            vec![],
        );
        let fact_id = add_item(
            &store,
            &kb_a.id,
            KbItemType::Fact,
            "zh-CN",
            "预发布端口",
            "预发布环境监听 8443 端口",
            vec![],
        );
        let other_proj_id = add_item(
            &store,
            &kb_b.id,
            KbItemType::Runbook,
            "zh-CN",
            "灯笼鱼官网 发布流程",
            "灯笼鱼官网 静态站点发布流程",
            vec![],
        );

        store
            .apply_kb_feedback(&stale_id, HumanFeedback::Stale)
            .unwrap();

        // Multi-query merges distinct topics cleanly!
        let merged = search_knowledge(
            &store,
            &SearchOptions {
                queries: vec!["发布流程".into(), "8443 端口".into()],
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert!(merged.hits.iter().any(|h| h.id == fresh_id));
        assert!(merged.hits.iter().any(|h| h.id == fact_id));

        // item_types filter keeps only Fact items
        let facts_only = search_knowledge(
            &store,
            &SearchOptions {
                queries: vec!["发布流程".into(), "8443 端口".into()],
                agent_id: Some(agent_a.id.clone()),
                item_types: vec![KbItemType::Fact],
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(facts_only.hits.len(), 1);
        assert_eq!(facts_only.hits[0].id, fact_id);

        // Named cross-project lookup
        let res_named = search_knowledge(
            &store,
            &SearchOptions {
                query: "灯笼鱼官网 发布流程".into(),
                agent_id: Some(agent_a.id.clone()),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(res_named.hits[0].id, other_proj_id);

        // Structured overflow `more_titles`
        let res_budget = search_knowledge(
            &store,
            &SearchOptions {
                query: "发布流程".into(),
                agent_id: Some(agent_a.id.clone()),
                byte_budget: Some(320),
                ..Default::default()
            },
            None,
        )
        .unwrap();
        assert_eq!(res_budget.hits.len(), 1);
        assert!(!res_budget.budget.complete);
        assert!(!res_budget.more_titles.is_empty());
        assert!(!res_budget.more_titles[0].id.is_empty());
    }
}
