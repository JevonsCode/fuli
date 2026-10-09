export const agentRedesignMessages = {
  "zh-CN": {
    refreshing: "正在更新 Agent 名录",
    membershipStatus: "成员 · {status}",
    projects: {
      more: "全部项目 · {count}",
    },
    workStatus: {
      label: "工作状态",
      awaiting_recruitment: "等待招聘",
      queued: "排队中",
      running: "运行中",
      paused: "已暂停",
      awaiting_review: "待审核",
      blocked: "阻塞",
      none: "空闲",
      loading: "正在读取工作状态",
      unreported: "状态不完整",
      unavailable: "读取失败",
      refreshError: "工作状态更新失败",
    },
  },
  "en-US": {
    refreshing: "Updating the Agent directory",
    membershipStatus: "Member · {status}",
    projects: {
      more: "All projects · {count}",
    },
    workStatus: {
      label: "Work status",
      awaiting_recruitment: "Awaiting recruitment",
      queued: "Queued",
      running: "Running",
      paused: "Paused",
      awaiting_review: "Awaiting review",
      blocked: "Blocked",
      none: "Idle",
      loading: "Loading work status",
      unreported: "Partial status",
      unavailable: "Unavailable",
      refreshError: "Work status could not be refreshed",
    },
  },
} as const;
