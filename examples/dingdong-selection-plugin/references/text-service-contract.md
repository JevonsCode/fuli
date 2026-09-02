# Text service contract

The browser example accepts an HTTPS endpoint, or an HTTP loopback endpoint for local development. It sends:

```json
{
  "action": "translate",
  "text": "selected text",
  "targetLanguage": "zh-CN"
}
```

`action` is `translate` or `explain`. The service returns JSON with one bounded string field:

```json
{
  "text": "provider result"
}
```

No endpoint is configured by default. Tests inject deterministic test doubles; their output is test-only and is never presented as a real translation or explanation.
