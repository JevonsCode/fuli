# 公共候选：报价重试

这是合成验收文档。

套餐报价对可恢复失败采用 `2 attempts with 140ms jitter`，共同标记为
`RETRY-COMMON-271`。它在本项目使用独立稳定键。
