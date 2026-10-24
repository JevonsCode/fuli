// The terms an Agent app approval covers in this version (rec#11 D-36.2,
// D-36.9, D-36.10). There is no system sandbox: an approved app runs in
// trusted mode, as a process of the user's own OS account. A terminal
// confirmation binds the exact package to these terms, and the run gate starts
// only a version confirmed under them. An approval made under other terms (the
// isolated mode of rec#7 PR①, Windows Hello approvals included) is never
// carried over: that version is confirmed again. Bump TERMS_VERSION whenever
// what these sentences promise changes, so every approval is asked again.
export const TRUST_MODE = 'trusted';
export const TERMS_VERSION = 1;

// The one warning shown before the app name is typed (D-36.2).
export const TRUST_WARNING = Object.freeze({
  zh: '这个应用会用你的账户权限在本机运行，FULI 不会隔离它。只批准你信任的应用。',
  en: 'This app runs on this computer with your account\'s permissions, and FULI does not isolate it. Approve only apps you trust.'
});

// What typing the app name shows and what it does not (D-36.9).
export const CONFIRMATION_NOTICE = Object.freeze({
  zh: '输入应用名即完成终端确认流程。这不证明是真人操作，也不能抵御以同一账户运行的其他程序。',
  en: 'Typing the app name completes the terminal confirmation flow. This does not prove a person did it, and it does not '
    + 'protect against other programs running under the same account.'
});
