// 待决策 as one list, and 「交给 Tonborg 确认」 (rec#96).
export const reviewListMessages = {
  'zh-CN': {
    headline: '{count} 件事等你',
    loading: '正在读取等你确认的事…',
    loadError: '待确认的事没读到，请重试',
    everywhere: '通用',
    byTonborg: 'Tonborg 替你确认',
    dropReason: '在待决策里点了「不要」',
    undoReason: '撤销了 Tonborg 的确认',
    voteReason: '你选了「{action}」',
    groups: { questions: 'Tonborg 想问你', pending: '待确认的知识', attention: 'Agent 在问你', confirmed: 'Tonborg 替你确认了' },
    reasons: {
      unreviewed: '还没人看过', tonborg_reviewed: 'Tonborg 看过，等你点头', tonborg_unsure: 'Tonborg 拿不准',
      conflict: '和别的条目冲突', attention: '需要留意', basis_changed: '依据变了',
    },
    actions: {
      confirm: '确认', drop: '不要', edit: '改一下', details: '查看详情', confirmAll: '全部确认', acceptGuesses: '全按猜的办',
      undo: '撤销', allRight: '都对', answer: '回答',
    },
    pending: {
      confirm: '正在确认这条知识…', drop: '正在把这条知识标为不要…', undo: '正在撤销 Tonborg 的确认…',
      ack: '正在记下你认可 Tonborg 的确认…', all: '正在确认全部待确认的知识…', guesses: '正在按 Tonborg 的猜测处理…',
    },
    done: {
      confirm: '已确认「{text}」', drop: '已标为不要「{text}」，可在知识里恢复', undo: '已撤销 Tonborg 对「{text}」的确认',
      all: '已处理 {count} 条',
    },
    details: {
      title: '详情', content: '内容', project: '项目', proposer: '谁提的', reason: '为什么还等着', tonborg: 'Tonborg 的理由', guess: 'Tonborg 的猜测',
    },
    delegation: {
      label: '交给 Tonborg 确认', saving: '正在保存「交给 Tonborg 确认」…',
      needsModel: '需要先给 Tonborg 接一个模型，会用掉它的 token。', connect: '去接模型',
      offHint: '打开后，Tonborg 按你的偏好替你确认清楚的知识，拿不准的一次问你。',
      onHint: 'Tonborg 正在替你确认；它做的每个决定都写着理由，可撤销。',
      on: '已交给 Tonborg 确认，几分钟内它会看完待确认的知识', off: '已收回，知识确认回到你手上',
    },
  },
  'en-US': {
    headline: '{count} things wait for you',
    loading: 'Loading what waits for your confirmation…',
    loadError: 'Could not load what waits for you. Try again',
    everywhere: 'Everywhere',
    byTonborg: 'Confirmed by Tonborg for you',
    dropReason: 'Chose “Drop” in Decisions',
    undoReason: 'Undid Tonborg’s confirmation',
    voteReason: 'You chose “{action}”',
    groups: { questions: 'Tonborg asks you', pending: 'Knowledge to confirm', attention: 'Agents ask you', confirmed: 'Tonborg confirmed for you' },
    reasons: {
      unreviewed: 'Nobody looked yet', tonborg_reviewed: 'Tonborg looked; waits for your nod', tonborg_unsure: 'Tonborg is unsure',
      conflict: 'Conflicts with another item', attention: 'Needs attention', basis_changed: 'Its basis changed',
    },
    actions: {
      confirm: 'Confirm', drop: 'Drop', edit: 'Edit', details: 'Details', confirmAll: 'Confirm all', acceptGuesses: 'Accept guesses',
      undo: 'Undo', allRight: 'All right', answer: 'Answer',
    },
    pending: {
      confirm: 'Confirming this item…', drop: 'Dropping this item…', undo: 'Undoing Tonborg’s confirmation…',
      ack: 'Recording that Tonborg’s confirmations are right…', all: 'Confirming every pending item…', guesses: 'Applying Tonborg’s guesses…',
    },
    done: {
      confirm: 'Confirmed “{text}”', drop: 'Dropped “{text}”; you can restore it in Knowledge', undo: 'Undid Tonborg’s confirmation of “{text}”',
      all: 'Handled {count} items',
    },
    details: {
      title: 'Details', content: 'Content', project: 'Project', proposer: 'Proposed by', reason: 'Why it waits', tonborg: 'Tonborg’s reason', guess: 'Tonborg’s guess',
    },
    delegation: {
      label: 'Let Tonborg confirm', saving: 'Saving “Let Tonborg confirm”…',
      needsModel: 'Connect a model for Tonborg first; it spends that model’s tokens.', connect: 'Connect a model',
      offHint: 'When on, Tonborg confirms the clear items your way and asks about the rest at once.',
      onHint: 'Tonborg confirms for you; every decision shows its reason and can be undone.',
      on: 'Handed to Tonborg; it will look through pending knowledge within minutes', off: 'Taken back; confirming knowledge is yours again',
    },
  },
}
