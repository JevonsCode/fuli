// The four verification states (rec#78) a task outcome or a learned experience
// shows. Only recorded evidence sets one; the evidence line says which.
export const verificationMessages = {
  'zh-CN': {
    states: { person_confirmed: '人确认', auto_verified: '自动验证通过', ai_assessed: 'AI 评估通过', unverified: '尚未验证' },
    title: '验收',
    loading: '正在读取任务的验收证据',
    sources: { person: '你确认过', verification: '测试证据 {count} 条', tonborg: "@:{'roleNames.tonborg'} 验收通过" },
  },
  'en-US': {
    states: { person_confirmed: 'Confirmed by you', auto_verified: 'Tests passed', ai_assessed: 'AI review passed', unverified: 'Not verified yet' },
    title: 'Acceptance',
    loading: 'Reading the task’s acceptance evidence',
    sources: { person: 'You confirmed it', verification: '{count} test evidence', tonborg: "@:{'roleNames.tonborg'} accepted it" },
  },
} as const
