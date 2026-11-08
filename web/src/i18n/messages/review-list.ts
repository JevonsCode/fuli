// 待决策 as one list, and 「交给 Tonborg 确认」 (rec#96).
export const reviewListMessages = {
  'zh-CN': {
    headline: '{count} 件事等你',
    loading: '正在读取等你确认的事…',
    loadError: '待确认的事没读到，请重试',
    everywhere: '通用',
    byTonborg: "@:{'roleNames.tonborg'} 替你确认",
    dropReason: '在待决策里点了「不要」',
    confirmAllReason: '在待决策里点了「全部确认」',
    undoReason: "撤销了 @:{'roleNames.tonborg'} 的确认",
    voteReason: '你选了「{action}」',
    groups: { questions: "@:{'roleNames.tonborg'} 拿不准，要你定", pending: '待确认的知识', attention: 'Agent 在问你', confirmed: "@:{'roleNames.tonborg'} 替你确认了" },
    reasons: {
      unreviewed: '还没人看过', tonborg_reviewed: "@:{'roleNames.tonborg'} 看过，等你点头", tonborg_unsure: "@:{'roleNames.tonborg'} 拿不准",
      conflict: '和别的条目冲突', attention: '需要留意', basis_changed: '依据变了',
    },
    guessed: "@:{'roleNames.tonborg'} 猜：{guess}",
    guessShort: { keep: '保留', drop: '不要', edit: '先改一下' },
    actions: {
      confirm: '确认', drop: '不要', edit: '改一下', details: '查看详情', confirmAll: '全部确认', acceptGuesses: '全按猜的办',
      undo: '撤销', allRight: '都对', answer: '回答',
    },
    pending: {
      confirm: '正在确认这条知识…', drop: '正在把这条知识标为不要…', undo: "正在撤销 @:{'roleNames.tonborg'} 的确认…",
      ack: "正在记下你认可 @:{'roleNames.tonborg'} 的确认…", all: '正在确认 {done}/{total}', guesses: "正在按猜的办 {done}/{total}",
    },
    done: {
      confirm: '已确认「{text}」', drop: '已标为不要「{text}」，可在知识里恢复', undo: "已撤销 @:{'roleNames.tonborg'} 对「{text}」的确认",
      all: '已处理 {count} 条', confirmedAll: '已确认 {count} 条知识', partial: '已处理 {count} 条，{failed} 条没成功，还在列表里',
    },
    details: {
      title: '详情', content: '内容', project: '项目', proposer: '谁提的', reason: '为什么还等着', tonborg: "@:{'roleNames.tonborg'} 的理由", guess: "@:{'roleNames.tonborg'} 的猜测",
    },
    explain: {
      title: "让 @:{'roleNames.tonborg'} 给你解释", lead: '在你的 AI 里新开一个会话，逐条讲清楚',
      copy: '复制给其他 AI', copyOnly: '复制给你的 AI', opened: "已在 {client} 打开 @:{'roleNames.tonborg'} 的解释",
      copied: "已复制 @:{'roleNames.tonborg'} 的解释，粘贴给你的 AI 即可", copyFailed: '没能复制，请手动复制下面这段',
      copyTag: '复制', pasteIn: '已复制，在 {client} 里粘贴发送',
    },
    delegation: {
      label: "交给 @:{'roleNames.tonborg'} 确认", saving: "正在保存「交给 @:{'roleNames.tonborg'} 确认」…",
      needsModel: "需要先给 @:{'roleNames.tonborg'} 接一个模型，会用掉它的 token。", connect: '去接模型',
      settings: '设置', settingsTitle: "在模型与用量里打开 @:{'roleNames.tonborg'} 的确认设置",
      offHint: "打开后，@:{'roleNames.tonborg'} 按你的偏好替你确认清楚的知识，拿不准的一次问你。",
      onHint: "@:{'roleNames.tonborg'} 正在替你确认；它做的每个决定都写着理由，可撤销。",
      on: "已交给 @:{'roleNames.tonborg'} 确认，几分钟内它会看完待确认的知识", off: '已收回，知识确认回到你手上',
    },
  },
  'en-US': {
    headline: '{count} things wait for you',
    loading: 'Loading what waits for your confirmation…',
    loadError: 'Could not load what waits for you. Try again',
    everywhere: 'Everywhere',
    byTonborg: "Confirmed by @:{'roleNames.tonborg'} for you",
    dropReason: 'Chose “Drop” in Decisions',
    confirmAllReason: 'Chose “Confirm all” in Decisions',
    undoReason: "Undid @:{'roleNames.tonborg'}’s confirmation",
    voteReason: 'You chose “{action}”',
    groups: { questions: "@:{'roleNames.tonborg'} is unsure; your call", pending: 'Knowledge to confirm', attention: 'Agents ask you', confirmed: "@:{'roleNames.tonborg'} confirmed for you" },
    reasons: {
      unreviewed: 'Nobody looked yet', tonborg_reviewed: "@:{'roleNames.tonborg'} looked; waits for your nod", tonborg_unsure: "@:{'roleNames.tonborg'} is unsure",
      conflict: 'Conflicts with another item', attention: 'Needs attention', basis_changed: 'Its basis changed',
    },
    guessed: "@:{'roleNames.tonborg'} guesses: {guess}",
    guessShort: { keep: 'keep', drop: 'drop', edit: 'edit first' },
    actions: {
      confirm: 'Confirm', drop: 'Drop', edit: 'Edit', details: 'Details', confirmAll: 'Confirm all', acceptGuesses: 'Accept guesses',
      undo: 'Undo', allRight: 'All right', answer: 'Answer',
    },
    pending: {
      confirm: 'Confirming this item…', drop: 'Dropping this item…', undo: "Undoing @:{'roleNames.tonborg'}’s confirmation…",
      ack: "Recording that @:{'roleNames.tonborg'}’s confirmations are right…", all: 'Confirming {done}/{total}', guesses: 'Applying guesses {done}/{total}',
    },
    done: {
      confirm: 'Confirmed “{text}”', drop: 'Dropped “{text}”; you can restore it in Knowledge', undo: "Undid @:{'roleNames.tonborg'}’s confirmation of “{text}”",
      all: 'Handled {count} items', confirmedAll: 'Confirmed {count} items', partial: 'Handled {count} items; {failed} failed and stay in the list',
    },
    details: {
      title: 'Details', content: 'Content', project: 'Project', proposer: 'Proposed by', reason: 'Why it waits', tonborg: "@:{'roleNames.tonborg'}’s reason", guess: "@:{'roleNames.tonborg'}’s guess",
    },
    explain: {
      title: "Let @:{'roleNames.tonborg'} explain", lead: 'Opens a new chat in your AI and goes through them one by one',
      copy: 'Copy for another AI', copyOnly: 'Copy for your AI', opened: "Opened @:{'roleNames.tonborg'}’s explanation in {client}",
      copied: "Copied @:{'roleNames.tonborg'}’s explanation; paste it into your AI", copyFailed: 'Could not copy; copy the text below',
      copyTag: 'Copy', pasteIn: 'Copied; paste it in {client} and send',
    },
    delegation: {
      label: "Let @:{'roleNames.tonborg'} confirm", saving: "Saving “Let @:{'roleNames.tonborg'} confirm”…",
      needsModel: "Connect a model for @:{'roleNames.tonborg'} first; it spends that model’s tokens.", connect: 'Connect a model',
      settings: 'Settings', settingsTitle: "Open @:{'roleNames.tonborg'}’s confirmation settings in Models and usage",
      offHint: "When on, @:{'roleNames.tonborg'} confirms the clear items your way and asks about the rest at once.",
      onHint: "@:{'roleNames.tonborg'} confirms for you; every decision shows its reason and can be undone.",
      on: "Handed to @:{'roleNames.tonborg'}; it will look through pending knowledge within minutes", off: 'Taken back; confirming knowledge is yours again',
    },
  },
}
