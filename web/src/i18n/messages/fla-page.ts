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
      unknownAgent: '未知 FLA',
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
      unknownAgent: 'Unknown FLA',
    },
  },
}
