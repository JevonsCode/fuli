# 开发与验收

[English](development.md) · 简体中文 · [README](../README.zh-CN.md)

基准、验收手册，以及测试源码的命令。

## 验收与源码开发

- [Alignment Benchmark](../FULI_ALIGNMENT_BENCHMARK.md)
- [Token 与准确率实测报告](https://xn--8ovp9s.xn--m8txu.com/fuli/report/)：多花多少 token、召回准不准，写明方法、模型、客户端、日期和还没测的部分
- [中文验收索引](../acceptance/README.md)
- [知识检索与确认流程图](../acceptance/知识检索与确认流程图.md)
- [外部知识库只读接入架构](external-knowledge-architecture.md)

```bash
npm install
npm test
npm run test:package
npm run test:external-knowledge:live
```

外部知识联网测试会临时下载两个公开官方文档仓库，验证只读同步和检索后删除整个临时目录。
该测试依赖网络，不属于默认测试套件。

Provider 验证：

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install "./graph-provider[dev]"
python -m compileall -q graph-provider/fuli_graph
python -m pytest -q graph-provider/tests
docker compose -f compose.graphiti.yml config --quiet
```

`npm run test:package` 会构建前端、生成真实 npm tarball、安装到隔离的全局前缀，并验证
`fuli` / `fl`、版本号、帮助信息和 Web UI。测试源码、QA 截图和内部设计文档不会进入 npm
包。
