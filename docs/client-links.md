# Client link manifest

`registry/client-links.json` says, for each Agent client, which documented
links open one of its sessions or conversations. FULI uses it to put an
「打开会话」 link next to a blocked task; other tools, such as DingDong, read the
same file. The file is data: a consumer builds a link from it with a few lines
of code and keeps no per-client branches.

Public copy: `https://raw.githubusercontent.com/JevonsCode/fuli/main/registry/client-links.json`

The 「打开会话」 link on a knowledge record's evidence is a different setting (Settings →
conversation launchers); agent-session-launcher checks it, see
[Shared client components](client-connections.md#shared-client-components).

## Format (formatVersion 1)

```json
{
  "format": "fuli-client-links",
  "formatVersion": 1,
  "manifestVersion": 1,
  "updatedAt": "2026-10-27",
  "clients": [
    {
      "id": "codex",
      "name": "Codex",
      "sessionLinks": [
        {
          "id": "codex-app-thread",
          "opens": "Codex",
          "template": "codex://threads/{sessionId}",
          "parameters": { "sessionId": { "format": "uuid" } },
          "platforms": ["macos", "windows"],
          "notes": "Opens the local Codex app chat with this thread ID.",
          "source": "https://learn.chatgpt.com/docs/reference/commands"
        }
      ],
      "noSessionLink": null
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `format` | Always `fuli-client-links`. |
| `formatVersion` | The shape of this file. A reader refuses a version it does not know. |
| `manifestVersion` | A positive integer, raised by one for every published change. A copy is newer only when this is higher. |
| `updatedAt` | The publication date, `YYYY-MM-DD`. |
| `clients[].id` | The client's identifier, as FULI names source applications: `codex`, `claude`, `claude_code`, `cursor`, `kiro`, `opencode`. |
| `clients[].name` | The name people see. |
| `clients[].sessionLinks[]` | The verified links, most useful first. Empty when the client documents none. |
| `clients[].noSessionLink` | Why there is no link; required exactly when `sessionLinks` is empty, otherwise `null`. A reader then shows the session ID with a copy button. |
| `sessionLinks[].id` | A stable identifier of this link. |
| `sessionLinks[].opens` | The app the link opens, for a label such as 「在 VS Code 中打开」. |
| `sessionLinks[].template` | The link with `{name}` placeholders. Each declared parameter appears exactly once. |
| `sessionLinks[].parameters` | Each placeholder and its `format`: `uuid` or `any`. |
| `sessionLinks[].platforms` | Where the link works: `macos`, `windows`, `linux`, `web`. |
| `sessionLinks[].notes` | What the link does and when it does not work. |
| `sessionLinks[].source` | The official documentation (https) the link was verified against. |

Unknown fields anywhere make the whole file invalid.

## Building a link

For a client and the values you have (FULI passes `sessionId`):

1. Take each entry of the client's `sessionLinks` in order.
2. Skip it unless every declared parameter has a value that matches its
   `format` (`uuid`: an RFC 4122 UUID; `any`: non-empty, no control characters).
3. Replace each `{name}` with the URL-encoded (`encodeURIComponent`) value.

No match means there is no link: show the session ID and a copy button. A
link is never guessed, and a reader never tells the person to run a command.

## Validation of a fetched copy

A copy fetched from the public URL is used only when all of this holds;
otherwise it is refused whole and the current copy stays:

- it is JSON of at most 256 KiB and matches the format above exactly;
- client and link IDs are distinct;
- every template parses as a URL whose scheme is `https` or one of the app
  schemes the reader ships with (FULI: `codex`, `vscode`, `vscode-insiders`,
  `cursor`, `claude`, `claude-cli`, `kiro`), with no credentials or fragment.
  `javascript:`, `data:`, `file:` and any other scheme are refused. A new app
  scheme ships with the reader, never with the manifest;
- every `source` is an https URL.

## How FULI updates it

FULI ships a bundled copy. 设置 → 会话链接 →「检查更新」 fetches the public copy,
validates it and shows what it would add, change and remove, by client; one
click applies exactly that version. With 「每天自动更新」 on, FULI checks once a
day and applies a valid newer copy itself. Every applied update is recorded
with its time and diff in `client-links.json` in the FULI data directory. Only
this manifest is updated, never FULI. When the fetch fails or the copy is
invalid, the current copy stays in use; a bundled copy newer than the applied
one (after a FULI upgrade) takes over.

## Changing the manifest

Add or change a link only after verifying it in the client's official
documentation or the installed app, and put that page in `source`. Raise
`manifestVersion` by one in the same change.
