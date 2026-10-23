// Only a cleared working-memory revision needs this guidance; ordinary task
// entries and the chat tool schema keep their existing byte budget.
export function scrubbedMemoryGuidance(revision) {
  return `当前工作记忆正文已随来源删除清除（修订 ${revision}），不会回退旧版本；本次任务结束时以 expectedRevision ${revision} 重新写入。 `
    + `The current working-memory text was cleared with a source deletion (revision ${revision}); it does not fall back to an older version. Rewrite it at the end of this task with expectedRevision ${revision}.`;
}
