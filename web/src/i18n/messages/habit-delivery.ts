// The habits FULI handed to the assistant when a conversation started (the 「FULI 习惯」 receipt line).
export const habitDeliveryMessages = {
  'zh-CN': {
    title: '交给助手的习惯',
    header: '这个对话一开始，FULI 交给助手的 {count} 条习惯',
    footnote: '助手有没有照做，看它的回复；FULI 只知道交给了它。',
    deleted: '这条后来删掉了',
    expired: '这条记录已经过期或不存在。',
    loading: '正在读取交给助手的习惯',
    loadFailed: '读不到这些习惯：{error}',
  },
  'en-US': {
    title: 'Habits given to the assistant',
    header: 'Habits FULI handed over when this conversation started: {count}',
    footnote: 'FULI knows it handed these over; whether they were followed shows in the reply.',
    deleted: 'This one was deleted later',
    expired: 'This record has expired or does not exist.',
    loading: 'Reading the habits given to the assistant',
    loadFailed: 'Could not read these habits: {error}',
  },
}
