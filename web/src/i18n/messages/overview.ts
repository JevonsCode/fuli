export const overviewMessages = {
  'zh-CN': {
    sections: {
      attention: '等你处理',
      currentWork: '进行中',
      recentlyDone: '最近完成',
      log: '进展',
      flas: 'FLAs 正在做',
    },
    stage: {
      aria: '当前工作',
      flaProgress: '{done}/{total} 位 FLA 已完成分工',
      flaDone: 'FLA 已完成分工',
      noLog: '这项工作还没有记录进展。',
      you: '你',
      system: '系统',
      switchTo: '切换到 {title}',
    },
    done: {
      empty: '还没有完成的工作。',
    },
    attention: {
      loading: '正在读取待处理请求…',
      meta: '{name}，{time}',
      loadFailed: '待处理请求暂时无法读取。',
      all: '查看全部 {count} 个请求', respond: '查看并回应',
    },
    work: {
      loading: '正在读取当前工作…',
      empty: '当前范围暂无进行中的工作。',
      loadFailed: '部分工作记录暂不可用。',
    },
    read: {
      scope: '正在读取工作台范围…', scopeFailed: '工作台范围暂不可用。', slow: '读取时间较长。', timeout: '读取超时。',
      reload: '重新读取', stale: '更新失败，显示上次结果。', lastRead: '上次读取 {date}', diagnostics: '诊断信息',
      denied: '访问权限已变化，请重新读取当前范围。', partial: '部分记录',
    },
    missing: { taskTitle: '未提供任务标题', requestTitle: '未提供请求标题', owner: '负责人未提供', name: '姓名未提供',
      nameLoading: '正在读取负责人姓名…', nameUnavailable: '负责人姓名暂不可用', project: '项目名未提供', status: '状态未识别', time: '时间未提供' },
    actions: { request: '查看请求', task: '查看任务', blocked: '查看阻塞详情', failed: '查看失败详情', awaiting_review: '查看交付记录' },
  },
  'en-US': {
    sections: {
      attention: 'Waiting for you',
      currentWork: 'In progress',
      recentlyDone: 'Recently done',
      log: 'Progress',
      flas: 'FLAs at work',
    },
    stage: {
      aria: 'Current work',
      flaProgress: '{done} of {total} FLAs finished their part',
      flaDone: 'FLAs finished',
      noLog: 'No progress recorded for this work yet.',
      you: 'You',
      system: 'System',
      switchTo: 'Switch to {title}',
    },
    done: {
      empty: 'Nothing finished yet.',
    },
    attention: {
      loading: 'Loading pending requests…',
      meta: '{name}, {time}',
      loadFailed: 'Pending requests are temporarily unavailable.',
      all: 'View all requests ({count})', respond: 'View and respond',
    },
    work: {
      loading: 'Reading current work…',
      empty: 'No active work in this scope.',
      loadFailed: 'Current tasks are temporarily unavailable.',
    },
    read: {
      scope: 'Reading workspace scope…', scopeFailed: 'Workspace scope is unavailable.', slow: 'Taking longer than usual.', timeout: 'Read timed out.',
      reload: 'Reload', stale: 'Update failed. Showing previous results.', lastRead: 'Last read {date}', diagnostics: 'Diagnostics',
      denied: 'Access has changed. Reload the current scope.', partial: 'Partial records',
    },
    missing: { taskTitle: 'Task title not provided', requestTitle: 'Request title not provided', owner: 'Owner not provided', name: 'Name not provided',
      nameLoading: 'Reading owner names…', nameUnavailable: 'Owner name unavailable', project: 'Project name not provided', status: 'Unrecognized status', time: 'Time not provided' },
    actions: { request: 'View request', task: 'View task', blocked: 'View blocking details', failed: 'View failure details', awaiting_review: 'View delivery record' },
  },
} as const
