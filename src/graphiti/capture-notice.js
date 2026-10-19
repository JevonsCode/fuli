// What a person is told when automatic recording did not run (rec#11 D-01).
// Edits the person submits explicitly are not automatic recording and still
// save, so every notice says so. A notice names the decision and any explicit
// operation that still ran, never anything that was not recorded.
const EXPLICIT_EDITS_SAVED = '你明确提交的修改仍会保存';
const EXPLICIT_OPERATION_RESULTS = Object.freeze({ project_created: '已创建项目，会话未记录' });

export function captureNotice(reason) {
  if (!reason) return null;
  return reason === 'policy_unavailable'
    ? `记录设置读取失败，本次未自动记录；${EXPLICIT_EDITS_SAVED}`
    : `自动记录已关闭；${EXPLICIT_EDITS_SAVED}`;
}

// A receipt's notices for one turn: the decision, then each explicit operation
// the person asked for that ran while automatic recording was off.
export function receiptNotices(decision, explicitOperations = []) {
  const notice = captureNotice(decision.reason);
  return notice ? [notice, ...explicitOperations.map(operation => EXPLICIT_OPERATION_RESULTS[operation])] : [];
}
