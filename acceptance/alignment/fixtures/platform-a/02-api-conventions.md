# 公共 API 约定

这是合成验收文档。

所有活动接口使用 `FULI-DEMO-ENVELOPE-v3` 响应封装。顶层字段固定为 `trace`、
`payload` 和 `fault`。调用方不得把领域错误直接塞进 HTTP 状态文本。
