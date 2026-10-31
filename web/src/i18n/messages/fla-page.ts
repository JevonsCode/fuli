// An FLA's own page (重写, direction A).
export const flaPageMessages = {
  'zh-CN': {
    sheets: {
      title: '任务单',
      loading: '正在读取 {name} 的任务单',
      failed: '没有读到任务单。',
      unsupported: '这个版本的 FULI 还不能显示任务单，更新后就能看到。',
      retry: '重试',
      empty: '{name} 现在没有任务。',
      partial: '任务太多，这里只显示最近的 200 个。',
      blocked: '这个任务被阻塞了。',
      shares: '分工',
      unknownAgent: '未知 FLA',
      roles: { lead: '负责人', collaborator: '协作', coordinator: '协调' },
      progress: '完成 {completed} / {total} 步',
      unassigned: '还有 {count} 步没有分给任何人',
    },
  },
  'en-US': {
    sheets: {
      title: 'Task sheets',
      loading: 'Reading {name}’s task sheets',
      failed: 'The task sheets could not be read.',
      unsupported: 'This version of FULI cannot show task sheets yet; update to see them.',
      retry: 'Retry',
      empty: '{name} has no tasks right now.',
      partial: 'Too many tasks: only the latest 200 are shown.',
      blocked: 'This task is blocked.',
      shares: 'Shares',
      unknownAgent: 'Unknown FLA',
      roles: { lead: 'Lead', collaborator: 'Collaborator', coordinator: 'Coordinator' },
      progress: '{completed} of {total} steps done',
      unassigned: '{count} steps are not assigned to anyone yet',
    },
  },
}
