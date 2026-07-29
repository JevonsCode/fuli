# Legacy frontend modules

The production browser entry is `web/src/main.ts`. Files in this directory are
kept temporarily for domain-level regression tests and the D3 renderer while
their remaining behavior is moved into typed Vue feature modules. They are not
loaded by `web/index.html` or included as a second application entry.
