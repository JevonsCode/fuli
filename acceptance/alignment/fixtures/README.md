# MOCK（合成）验收语料

本目录全部是虚构数据。任何产品名、业务规则、日期、编号、架构决策和对话内容都只在
Fuli 对齐验收中成立。

目录名同时是 Fuli 的个人项目稳定标识：

- `platform-a`：父项目与公共仓库；
- `hotel-b`、`flight-c`、`travel-d`：三个子项目；
- `botany-e`：无关负向对照项目；
- `platform-b`：第二父项目；
- `related-c`：只通过 `RELATED_TO` 关联 `travel-d` 的项目；
- `preference-e`：`platform-a` 的第二个偏好样本子项目。

`related-c/02-comment-preference.md` 与 D/E 的局部偏好一起验证：跨无共同父级的
共同核心只能形成个人全局候选，并且仍需人工判定作用域。

多智能体关系网用例采用以下额外关系：

- `travel-d --PART_OF--> platform-a`；
- `travel-d --PART_OF--> platform-b`；
- `preference-e --PART_OF--> platform-a`；
- `related-c --RELATED_TO--> travel-d`。

运行器会把这些目录复制到一次性临时工作区，再让 Codex、Cursor 和 Claude Code
读取。三个 Agent 都不会在仓库原文件上执行写操作。
