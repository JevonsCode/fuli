# Develop and verify FULI

English · [简体中文](development.zh-CN.md) · [README](../README.md)

Benchmarks, acceptance runbooks and the commands that test the source.

## Acceptance and development

- [Alignment Benchmark](../FULI_ALIGNMENT_BENCHMARK.md)
- [Token and accuracy report](https://xn--8ovp9s.xn--m8txu.com/fuli/report/en/): measured token use and recall accuracy, with method, model, client, date and what is not measured yet
- [Chinese acceptance index](../acceptance/README.md)
- [Knowledge retrieval and confirmation diagrams](../acceptance/知识检索与确认流程图.md)
- [Read-only external-knowledge architecture](external-knowledge-architecture.md)

```bash
npm install
npm test
npm run test:package
npm run test:external-knowledge:live
```

The external-knowledge live test temporarily downloads two public official documentation
repositories, validates read-only synchronization and retrieval, then removes the complete
temporary directory. It is network-dependent and is not part of the default test suite.

Provider validation:

```bash
python3.12 -m venv .venv
. .venv/bin/activate
python -m pip install "./graph-provider[dev]"
python -m compileall -q graph-provider/fuli_graph
python -m pytest -q graph-provider/tests
docker compose -f compose.graphiti.yml config --quiet
```

`npm run test:package` builds the web UI, creates a real npm tarball, installs it into an isolated
global prefix, and verifies `fuli` / `fl`, version output, help output, and the packaged UI. Tests,
QA screenshots, and internal design documents are excluded from the npm package.
