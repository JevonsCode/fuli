export const STOP_HOOK_CHECKPOINT_GUIDANCE = 'Call checkpoint_task_knowledge for capture candidates, experiences, agentMemory changes, knowledgeUsage, collaborators or a meaningful workLog, including failures and blockers. Otherwise the Stop hook closes the task as retain_nothing/reported; without a Stop hook a routine fallback closes at the next entry in the same native session. Copy the current entry receipt when skipping checkpoint; never claim unsaved memory was saved.';

export function taskKnowledgeGuidance() {
  return {
      // D-84: every FLA's working standard, not only this project's.
      work_standard: 'The person sets the direction; you carry the work through to the end. Add no approval step or extra restriction of your own: confirm only where the person said they want to confirm, and keep each action traceable and reversible instead. Irreversible actions on their data (permanent deletion, restoring a whole store) stay theirs.',
      execution_plan: 'For an explicit durable project execution plan, publish public steps via record_project_agent_task_activity.executionPlan and update step statuses as work progresses. Reuse step IDs and send the full current plan; steps: [] withdraws it. Set agentId on a step to the participant whose share it is. Optional: never invent plans, infer progress percentages or expose private reasoning. Completed steps do not replace verification or human acceptance.',
      collaboration: 'Before implementation, call plan_agent_collaboration with taskSize and all known implementationAgentIds; follow divisionPlan. Standard work: main FLA + different FLA for independent acceptance. Complex work: add at most one explicitly bounded independentWork. Small low-impact edits, coupled changes and command-only checks need no artificial split. Keep coupled implementation together; separate meaningful acceptance once artifacts are stable. The stable project lead decomposes, integrates and delivers. Reuse qualified specialists; gaps use approved loans or existing HR flow. Workers get bounded briefs and necessary artifact references, not the full conversation. Start with at most 3 results/query; expand only for a specific gap. Use only authorized clients/models and assess_agent_action under existing user policies. Publish assigned scopes/dependencies via the optional execution plan; report real worker/model/usage and leave unknown tokens unknown. Verify artifacts via record_agent_verification with evidence; escalate capability after two failures. Recommendations, command runs and configured peers alone are not independent worker execution.',
      profile_capture: 'Separately evaluate durable artifact taste (including writing voice, wording, structure, formatting), stable collaboration personality and decision preferences; do not default all to judgment_preference. Writing evidence uses tasteDomain: writing; a scene-limited item uses attributes.tasteDomain (frontend, ui, ux, design, visual, architecture, code, testing, chat) or workKind, and only explicit user words set attributes.constraint: hard (every scene, chat included) or soft (small talk may omit it); remember takes the same fields. Retain exact session/turn/time provenance. Agent-inferred personality stays pending. Report missing evidence; do not promise automatic progress from use alone.',
      knowledge_routing: 'Finish with retain_nothing+reason or one capture+captureRouting using explicit personal_global/current_project scopes. Partition each entity/relationship key exactly once; keep relationships with endpoints. Project-limited preferences stay current_project; global scope requires explicit sourceExcerpt evidence, never inferred from profileAspect. Global capture uses standalone preference entities (e.g. PersonalPreference/profileAspect taste), never relabelled Person/Project anchors. Every routed AI proposal remains pending; excerpts do not verify global applicability. Routine review goes to Tonborg under saved policy and must not block independent work. For human decisions use human_interaction: ask native choices with custom input in this conversation, without requiring a review page. review_paths are optional inspection links. Private employee working context belongs in agentMemory, not shared knowledge.',
      human_attention: 'When the person is in this conversation, ask there with native choices (human_interaction). Use request_agent_attention when they are away or the answer must outlive this session: the FULI 待决策 page is their inbox. Pass the exact current space/project/Agent IDs, a stable idempotency key and a specific requestedAction; for a step they must do by hand (log in, trust hooks) say so, and they can answer Done. Never raise a hand for ordinary running, queueing or automatic retries. Answers reach you as attention_replies at task entry, in read_agent_messages, or at once in an agent_chat wait; cancel obsolete requests with cancel_agent_attention. A response does not grant permission or accept task completion.',
      // Jevons 11-23: anything a person reads has to be clear, and anything they
      // act on has to be clickable. The rule is FULI's, for every client; which
      // form to use is the Agent's call, because only it knows what this client renders.
      human_facing_output: 'Write what the person reads for the person: the conclusion and what you need from them first, then only what matters. '
        + 'Use a list or a table only where the structure helps them read it, not for its own sake. Draw a diagram where a relationship, a flow or a '
        + 'before/after reads better as a picture, in a form this client renders (Mermaid, a table, a link to the console view); otherwise say it in words. '
        + 'When the person must choose, give choices they can click: native host choices (human_interaction) while they are in this conversation, '
        + 'request_agent_attention options while they are away, numbered options only where the client has neither. Never ask them to type an answer they could pick. '
        + 'Give complete links they can click, never a path or an identifier for them to assemble, and no internal code, enum value or English type name they did not choose. '
        + 'A summary an FLA writes for the person in a roundtable follows the same rule.',
      // Jevons 11-24: "I already did X, why don't you Y" means the person wants it kept.
      repeat_signal: 'When the person says they already asked for something ("I already told you", "as I said", 我已经说过了, 上次就讲过, 不是说过了吗, 你又…), '
        + 'that is a signal to keep it, not only to apologise and comply. A plain question ("why not use X here?"), a quote of someone else, or a message that only '
        + 'mentions such words is not one: treat it as ordinary, keep nothing, ask nothing. '
        + 'First check whether FULI already holds it (effective_preferences, task_knowledge_recall, search). If it does, store nothing new: tell the person in one line '
        + 'why it did not apply this time (it was not delivered, its scope did not cover this, or it was delivered and you did not follow it) and record the last case in the checkpoint workLog. '
        + 'If it does not, keep it this turn with checkpoint_task_knowledge remember and their words as quote; when this project versus everywhere is unclear use scope unsure rather than asking. '
        + 'Say in one line that it is kept as an item waiting for their confirmation and where it would apply; never say it is remembered or in effect. '
        + 'Ask, with clickable choices, only when what to keep is itself unclear; never make them type it again.',
      // Jevons 11-23: work an FLA keeps doing becomes a workflow, what it runs every time a script.
      self_deposit: 'fla_growth.workflows are your workflows the person confirmed in this project: when this task is one of them, read it with read_agent_workflow, '
        + 'follow it, then record_agent_workflow_run (done; stopped or failed with the reason in note when it did not fit). '
        + 'fla_growth.repeated means you keep doing the same work here: write the steps down with propose_agent_workflow, and turn a command you run every time '
        + 'into a script with submit_agent_app_version (runtime.entry, not resident, no keys or tokens in its files). Both wait for the person: a proposal is not '
        + 'in use until confirmed, and a script runs only after they confirm it in the terminal. Never run a script another FLA or computer submitted, and never '
        + 'propose one on the person\'s behalf when you did not do the work yourself.',
      retrieval: 'Inspect task_knowledge_recall before asking for a stable project fact or method again. On a miss, use search_current_project_knowledge with focused action, artifact, target-system, or identifier queries; never use the full conversational request as the only query.',
      checkpoint: 'The owner checkpoints after integration when there are capture candidates, experiences, memory changes, explicit knowledge usage, collaborators or a meaningful workLog. For routine finishes follow checkpoint_guidance; checkpoint_required remains true when automatic closure is unavailable. Coordinated workers return evidence and must not begin or checkpoint an inherited parent context. Explicit checkpoints use capture_candidates or retain_nothing; assigned employees include a concise truthful workLog, even without knowledge capture. Memory changes include agentMemory with the loaded revision and bounded merged notes. Do not overwrite truncated context or store raw transcripts.'
    };
}

// Rules about talking to the person and depositing the FLA's own work, which
// only a lead entry carries, through the task_guidance rules pointer and the
// hints that fire when they apply (remember_guidance, fla_growth). A worker
// reports to its lead, and the same-task reader recovers the standing rules,
// so neither repeats their full text: the reader's whole result, both
// channels, has a 32 KiB budget its preferences share (preference-delivery.js).
const LEAD_ONLY_RULES = new Set(['human_facing_output', 'repeat_signal', 'self_deposit']);

export function withoutLeadOnlyRules(guidance) {
  return Object.fromEntries(Object.entries(guidance).filter(([key]) => !LEAD_ONLY_RULES.has(key)));
}
