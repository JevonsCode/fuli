// What FULI tells the person when a turn is not recorded (rec#5 C5). One wording
// for every Agent: the receipt carries it on every turn while it applies, and it
// names the capture decision only, never anything from the turn itself.

const RECEIPT_NOTICES = Object.freeze({
  global_off: '记录已关闭',
  client_off: '记录已关闭',
  project_off: '此项目未开启记忆',
  project_unregistered: '当前目录不是 FULI 项目，未记录',
  policy_unavailable: '记录设置读取失败，本次未记录'
});
// A reason this version has no wording for still says that nothing was
// recorded. Session pause (rec#5 C3) adds its own notice with its start time.
const UNNAMED_REASON_NOTICE = '本次未记录';

export function captureNotice(decision) {
  if (!decision || decision.allowed !== false) return null;
  return RECEIPT_NOTICES[decision.reason] ?? UNNAMED_REASON_NOTICE;
}

// Host hooks add a message of their own only when FULI could not read the
// settings: the person believes recording is on. A choice the person made is
// shown by the receipt instead, so it is not repeated in every hook message.
const UNREADABLE_SETTINGS_HOOK_NOTICE = 'Capture settings could not be read, so nothing from this turn was recorded';

export function captureHookNotice(result) {
  return result?.status === 'capture_disabled' && result.reason === 'policy_unavailable'
    ? UNREADABLE_SETTINGS_HOOK_NOTICE : null;
}
