// The advanced areas (features/advanced-areas): each one's name and line, and
// the 设置 › 系统 card that shows an area before it is used.
export const advancedAreasMessages = {
  'zh-CN': {
    card: {
      title: '还没用到的功能',
      line: '用到时会自己出现。想先看看，点「显示」。',
      show: '显示',
    },
    areas: {
      roundtable: { name: '圆桌和小组讨论', line: '助手之间互相商量的地方' },
      tonborg: { name: '自动确认', line: "让 @:{'roleNames.tonborg'} 替你确认常规的事" },
      tidy: { name: '整理', line: '让 AI 把记下的东西理一遍' },
      lan: { name: '局域网配对', line: '和同一网络里的另一台电脑配对' },
    },
  },
  'en-US': {
    card: {
      title: 'Not used yet',
      line: 'Each one appears by itself once you use it. To see one now, press Show.',
      show: 'Show',
    },
    areas: {
      roundtable: { name: 'Roundtable and group discussions', line: 'where your assistants talk to each other' },
      tonborg: { name: 'Automatic confirmation', line: "@:{'roleNames.tonborg'} confirms routine items for you" },
      tidy: { name: 'Tidying', line: 'your AI goes over what it remembered' },
      lan: { name: 'LAN pairing', line: 'pair with another computer on your network' },
    },
  },
} as const
