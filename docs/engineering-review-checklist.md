# 工程复查

## 测试工具开关

`cleanup_test_project_agents` 默认不出现在 MCP 工具列表，HTTP 测试清理接口默认
返回 404。需要时在测试进程明确设置 `FULI_ENABLE_TEST_TOOLS=1`。
工具目录保留定义，调用仍必须通过服务端权限边界。

开关实现统一在 `src/app/test-tools.js`。MCP 启动时传入的环境与调用时的请求上下文
共享同一快照，避免工具已公开却因进程环境不同而无法调用。HTTP 使用进程环境。
客户端工具参数不能打开这个开关。清理工具标记为 destructive。

## 验证顺序

使用满足 `package.json` engines 的 Node 版本，先构建静态控制台，再运行回归：

```sh
npm run build
npm test
PYTHONPATH=graph-provider python -m pytest graph-provider/tests
```

数据库集成测试使用明确标记的一次性数据库。对话、借调和质量门的边界见
[对话与协作](agent-conversations-and-collaboration.md)。

## 后续可独立处理的结构问题

- `src/graphiti` 和旧测试夹具仍有历史命名；重命名涉及脚本、导入和兼容，不能只凭名称删除。
- MCP 默认工具面较大，可评估按工作流分组，但需保留现有调用契约。
- 新客户端适配应放在 `src/agents` 对应目录，并单独验证生命周期和 transcript 格式。
- 疑似死代码先查调用、打包入口和外部 API 契约，再删除；真实客户端验收与协议测试分开记录。
