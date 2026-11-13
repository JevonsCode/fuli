// 复利账单, day by day (features/statement-calendar): the last year as a
// calendar, and the statement of the week picked in it. Everyday words only.
export const statementCalendarMessages = {
  'zh-CN': {
    title: '复利账单',
    open: '全部，按天看复利账单',
    calendar: '最近一年的每一天',
    measure: '看哪一项',
    measures: {
      learned: { label: '新学到的', count: '新学到 {count} 条' },
      confirmed: { label: '确认的', count: '确认了 {count} 条' },
      carried: { label: '带上习惯的对话', count: '{count} 次对话带上了习惯' },
      used: { label: '被用上', count: '被用上 {count} 次' },
    },
    cell: '{date}：{text}',
    legend: { less: '少', more: '多', label: '颜色越深，这一天越多' },
    week: { previous: '上一周', next: '下一周', range: '{from} 到 {to}' },
    day: { none: '{date} 没有记下东西。', some: '{date}：{text}' },
    loading: { days: '正在读取每一天的复利账单', week: '正在读取 {range} 的复利账单' },
    empty: '还没有哪一天记下过东西。对你的 AI 说一条习惯，这里就会亮起来。',
    failed: '每一天的账单还读不到。',
    weekFailed: '这一周的账单还读不到。',
  },
  'en-US': {
    title: 'Compounding statement',
    open: 'All, the statement day by day',
    calendar: 'Every day of the last year',
    measure: 'Which number',
    measures: {
      learned: { label: 'Newly learned', count: '{count} learned' },
      confirmed: { label: 'Confirmed', count: '{count} confirmed' },
      carried: { label: 'Chats with your habits', count: '{count} with your habits' },
      used: { label: 'Put to use', count: 'put to use {count}×' },
    },
    cell: '{date}: {text}',
    legend: { less: 'Less', more: 'More', label: 'Darker means more on that day' },
    week: { previous: 'Previous week', next: 'Next week', range: '{from} to {to}' },
    day: { none: 'Nothing was counted on {date}.', some: '{date}: {text}' },
    loading: { days: 'Reading the statement day by day', week: 'Reading the statement for {range}' },
    empty: 'Nothing has been counted on any day yet. Tell your AI a habit and this lights up.',
    failed: 'The statement by day cannot be read yet.',
    weekFailed: 'This week\'s statement cannot be read yet.',
  },
} as const
