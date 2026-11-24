// Team work: 团队卡片 and 悬浮岛 (tasks several FLAs do together).
export const teamWorkMessages = {
  'zh-CN': {
    glossary: { teamCard: '团队卡片', island: '悬浮岛' },
    cards: { title: '一起在做', loading: '正在读取 FLA 一起做的任务' },
    card: {
      flas: '{count} 位 FLA',
      now: '{name} 正在做：{step}',
      nowSelf: '现在：{step}',
      allSteps: '全部 {count} 步',
      progress: '完成 {completed} / {total} 步',
      shares: '分工',
      blocked: '这个任务被阻塞了。',
      unassigned: '还有 {count} 步没人负责',
      open: '打开任务',
      unknownAgent: '未知 FLA',
      roles: { lead: '负责人', collaborator: '协作', coordinator: '协调' },
    },
    // The last recorded change, said as a fact (work-freshness.ts); never 停了.
    progress: { at: '最近进展 {time}', justNow: '刚刚有进展', none: '没有记下最近进展' },
    island: {
      region: 'FLA 一起在做的任务',
      label: '{count} 位 FLA 正在一起做「{title}」',
      fold: '收起 {count} 个一起做的任务',
      unfold: '展开 {count} 个一起做的任务',
    },
  },
  'en-US': {
    glossary: { teamCard: 'Team card', island: 'Island' },
    cards: { title: 'Working together', loading: 'Reading the tasks FLAs share' },
    card: {
      flas: '{count} FLAs',
      now: '{name} is on {step}',
      nowSelf: 'Now: {step}',
      allSteps: 'All {count} steps',
      progress: '{completed} of {total} steps done',
      shares: 'Shares',
      blocked: 'This task is blocked.',
      unassigned: '{count} steps have no one yet',
      open: 'Open task',
      unknownAgent: 'Unknown FLA',
      roles: { lead: 'Lead', collaborator: 'Collaborator', coordinator: 'Coordinator' },
    },
    progress: { at: 'Last progress {time}', justNow: 'Progress just now', none: 'No recent progress recorded' },
    island: {
      region: 'Tasks FLAs are doing together',
      label: '{count} FLAs are working on “{title}”',
      fold: 'Fold {count} shared tasks',
      unfold: 'Show {count} shared tasks',
    },
  },
}
