// The three ways an ask brings its recipient in, tried in order (rec#109):
//   1. resume  — the recipient's own latest session in its client (Claude Code
//                forks it; Codex queues behind a running turn or skips it);
//   2. new_session — a new session as the recipient, the sender's own client first;
//   3. stand_in — the sender's session takes the recipient on as a labelled
//                 「代入」: same model, the recipient's shareable scope only.
// Each step records what it tried and why it did not answer, so the sender is
// never left with a bare `queued` (rec#110 item 1).

const LADDER_TIERS = Object.freeze(['resume', 'new_session', 'stand_in']);

// A paired device's ask wakes at most this many times on the owner's computer
// (the latest session, a new one in its client, then the share's other
// clients), each with its own grant; no stand-in answers for a remote ask.
export const REMOTE_WAKE_ATTEMPTS = 3;

// Why a step did not answer, in words the person reads as they are.
const REASONS = {
  no_previous_session: '没有可续接的历史会话',
  session_not_found: '本机找不到这个会话',
  session_busy: '这个会话正在跑一轮，不插话',
  client_unavailable: '客户端没安装或启动失败',
  client_login_required: '客户端没登录',
  client_not_allowed: '该 FLA 不允许在这个客户端运行',
  no_client: '没有可启动的客户端',
  no_working_directory: '本机不知道目标项目的目录',
  sender_without_project: '发起方不在项目任务里，无法签发唤醒授权',
  not_permitted: '团队规则不允许直接联系这个 FLA',
  delegation_not_redeemed: '新会话没有以该 FLA 身份进入',
  session_mismatch: '回答的会话不是被唤醒的那个',
  wake_failed: '会话没有给出回答',
  wake_timeout: '会话超时未答，可能仍在运行',
  codex_app_failed: 'Codex 桌面端拒绝了请求',
  waiting_in_desktop_app: '已交到桌面端会话，等待回复',
  cancelled: '已取消'
};

// Failures after which nobody may stand in: the recipient may still be
// running, the team rules refused it, or the sender chose not to wait.
const NO_STAND_IN = new Set(['wake_timeout', 'cancelled', 'not_permitted', 'execution_claimed',
  'cleanup_unconfirmed', 'chat_waiting', 'nested_limit', 'not_waiting', 'task_context_required']);

export function createWakeLadder() {
  const steps = [];
  return {
    skip(tier, { client = null, session = null, reason }) {
      steps.push({ tier, client, session, outcome: 'skipped', reason });
    },
    attempt({ client, sessionId }, outcome, reason = null) {
      steps.push({ tier: sessionId ? 'resume' : 'new_session', client, session: sessionId ?? null, outcome, reason });
    },
    // reached: the tier that answered or holds the ask; null when none did.
    // Steps read in tier order (targets are planned before any runs), and a
    // later tier passed over in planning is not said when an earlier one held.
    view(reached) {
      const rank = tier => LADDER_TIERS.indexOf(tier);
      const shown = steps.map((step, order) => ({ step, order }))
        .filter(({ step }) => reached === null || rank(step.tier) <= rank(reached))
        .sort((a, b) => rank(a.step.tier) - rank(b.step.tier) || a.order - b.order)
        .map(({ step }) => ({ ...step, ...(step.reason ? { why: REASONS[step.reason] ?? step.reason } : {}) }));
      return { reached, steps: shown };
    }
  };
}

export function standInAllowed(reason) {
  return !NO_STAND_IN.has(reason);
}
