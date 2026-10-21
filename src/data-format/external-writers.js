// The boundary of a confirmed graph migration (rec#17 D-09 part 2): FULI
// fences its own writers (every provider and its CLI tools) while a step is
// applied or undone, but cannot hold back a program that writes to the
// graph directly. One wording, said by `fuli migrate apply` and `rollback`,
// `fuli setup` when a migration waits, and the console's data format page
// (web/src/i18n/messages/data-format.ts carries the same two strings; a test
// keeps them equal).
export const EXTERNAL_WRITERS_NOTICE = Object.freeze({
  zh: '应用或撤销迁移前，请先停掉 FULI 以外直接写图谱的程序（Neo4j 客户端、cypher-shell 等工具）：FULI 拦不住它们的写入。',
  en: 'Before you apply or undo a migration, stop anything outside FULI that writes to the graph directly '
    + '(a Neo4j client, cypher-shell or other tools): FULI cannot hold their writes back.'
});

export function externalWritersLines() {
  return [EXTERNAL_WRITERS_NOTICE.zh, EXTERNAL_WRITERS_NOTICE.en];
}
