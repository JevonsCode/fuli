# Tonborg and autonomy

Tonborg is the built-in judgment Agent, alongside Jefa and Bole. It has a persistent FLA identity, scoped Agent memory, and a native decision workbench. All Agents can be pinned from their card; pins appear in navigation. The three built-in roles are the initial defaults. Removing a pin, including every pin, survives reloads.

## Choose the amount of autonomy

Settings offers three choices, saved immediately with Undo:

- **I decide**: Tonborg analyzes and records suggestions.
- **Shared decisions**: Tonborg applies routine knowledge reviews backed by existing confirmation and accepts verified FULI tasks.
- **Autonomous**: Tonborg may also review ordinary pending knowledge. Conflicts, sensitive preferences, uncertain evidence, and actions outside existing authority remain for the user.

Projects inherit the global policy unless the user sets an exception. Updating FULI does not silently expand existing authority.

## Who answers a judgment

When Tonborg has its own model in `model-backends.json` (rec#8), that model answers through FULI's model port, within its budget and data-sharing approval. Otherwise, or when that model fails in a way its settings allow to fall back, Tonborg records a **pending** work package and the current active session answers it with `role_work`; the host checks that answer exactly like a model answer, and the judgment then runs its usual gates. A package is not an answer: nothing is judged or executed until a session submits, a late or mismatched answer is stale, and without an active session the package waits, also across restarts. One answer is applied once: a repeated submit meanwhile reports `applying`, `completed` arrives only with the stored result, and an answer interrupted by a restart is applied by a submit after its 10-minute execution window. A review stores its write intent before it writes to the Provider; after an interruption the next run settles that intent against the decision the Provider holds (applied, not applied, or stale) and stays unfinished while the Provider cannot answer. A slow run whose window was taken over records nothing, so the result of the run that took over stands. A package belongs to its session binding; when another session asks about the same evidence it gets its own package and the older one is closed, so only one answer can be used. FULI does not start a CLI, a new session or another model for it. A refusal, a permission or privacy stop, or an exhausted budget stops the judgment instead.

A session that answers its own task's acceptance is not an independent verification: Tonborg records its verdict and leaves the decision to a person. The earlier CLI client runs only when the policy explicitly sets `backend: "legacy_cli"`; policies saved before this change keep their records readable but never start a CLI. Logs show the actual model only when the backend reports it. Settings reads each role's backend and open work packages at `GET /api/model-backends/roles`.

## When Tonborg's own model executes a review

A model the person configured for a role is trusted by default (rec#10 D-36). Today one operation can run by itself on that trust: Tonborg's knowledge review write-back (`knowledge_review`). Astro's, Bole's and Jefa's model results, and Tonborg's routing and acceptance answers, are unchanged by it.

A review approval is written back without the person only when all of these hold at the moment of the write:

- **Tonborg's configured model answered it.** The role is enabled in `model-backends.json`, `knowledge_review` is in its allowed operations, and the role still names the same connection that answered: the same connection id, protocol, endpoint and model. An answer from the current session (no model, a disabled role, or a fallback after the model failed) or from an opted-in legacy CLI is a suggestion, as before this change (`session_answer`). An answer from a connection the role no longer names is not trusted (`connection_changed`), including the same model name on another connection and the same connection with its endpoint changed in place.
- **The role is not set to 「只给建议 / Suggestions only」.** Each role card on the model settings page has this switch; it is off by default. When it is on, every answer is a suggestion (`suggestions_only`).
- **The person has read the warning.** Next to the switch the card says: 「模型可能判断错，它的判断会直接生效；你可以随时改成「只给建议」，部分写入可在回执里撤回。」 It counts as read only when the person presses 「我已看过 / I have read this」 on the settings page. Opening the page, rendering a receipt or any background read never sets it. Until then the configured model's approval is a suggestion (`warning_not_seen`), and that receipt shows the same warning with a link to the settings page. The item stays a suggestion for the person; it is not asked again while its evidence is unchanged.
- **Every rule that applied before still allows it.** Trust relaxes none of them: the autonomy choice (**I decide** keeps every approval a suggestion), items that need attention or have negative or conflicting evidence, the confidence floor, Tonborg's permission for the scope, the role's data-sharing approval for the review's project as it is now (`egress_not_approved`), the capture switch for the scope, globally and for the project (`capture_off`), the hard-delete fence, injection isolation of the evidence, the injection pattern pre-check below, and the Provider's evidence snapshot check. These checks govern what passes through FULI's host; they are not a sandbox.

### Injection pattern pre-check

Before an approval can apply, the host matches every text of the candidate against a fixed list of known injection patterns (`src/judgment/review-injection-precheck.js`, rec#26). The patterns cover six shapes: instructions addressed to the reviewer or the model, or text that replaces its instructions (`reviewer_instruction`); claims that a system, host, administrator or the user already approved it (`authority_claim`); attempts to set the outcome or the confidence (`outcome_directive`); the review prompt's own sections, chat-template turns or review JSON (`boundary_or_format`); tool-call syntax (`tool_call`); and characters that hide or reorder text (`hidden_characters`). Full-width letters and zero-width characters are folded first. The check uses no model and no Agent and is the same for every client.

When a candidate matches, its approval gets the interception `injection_suspected`: it is escalated to the person whatever the model answered and whether or not the role is trusted. The record keeps the model's own conclusion and lists the matched signals in `aiReview.injectionSignals`. The workbench shows them as 「已知注入格式 / Known injection pattern」, and the person's question starts with 「宿主预检：候选文本匹配已知注入格式」. The signals are recorded even when the model escalated by itself. Nothing is rejected or discarded by the check.

One model request judges a batch of up to ten candidates, so injected text in one of them may steer the verdicts of all. When any candidate of a batch matches, no approval from that answer applies: each other candidate's approval gets `batch_contaminated`, its record says `aiReview.injectionInBatch`, and the person sees 「宿主预检：同批候选匹配已知注入格式」. Those candidates are not reviewed again in a separate request; the person decides them like any other suggestion.

**Limits.** This is a narrow layer, not injection protection. It catches only the shapes its patterns were written against. On a 40-sample synthetic blind set (20 injection, 20 ordinary) written without reading the patterns, recall was 6/20 and false positives 1/20 (rec#11 D-56); this is not a real-world attack recall rate. The patterns were written after reading the injected texts of the Tonborg review evaluation sets, so the 10/10 they catch there says nothing about unseen text. Paraphrases, other languages, encodings, text split across fields and injection phrased as ordinary evidence (a false claim that the user stated a standing rule) pass it. A candidate without a match is not thereby safe; the other checks above and the person's decision remain the safeguards, and this check replaces none of them.

The choice and the acknowledgement are kept per role in `model-trust.sqlite`, a versioned store in the data directory. A missing store means trusted, warning not read. Nothing migrates into it: upgrading changes no existing choice, neither the autonomy policy nor the model settings. A role whose model was configured before the upgrade executes nothing by itself until its warning is read.

**When a switch takes effect.** A review's commit point is the moment its apply intent is stored in Tonborg's decision store. That happens under the trust store's write lock, after the role's mode, warning acknowledgement, connection identity and data-sharing approval and the capture switch were read again under the same lock. A switch to 「只给建议」 takes the same lock, so every review lands on one side of it:

- **No stored intent when the switch commits** (the model is still answering, or the answer is waiting for its write): the review checks again at its commit point, sees 「只给建议」 and writes nothing. Its receipt is `stale` with the reason `suggestions_only`, and the next review makes it a suggestion.
- **Intent stored before the switch commits:** the review had already started applying, exactly like a write that finished a moment before the switch. It completes the Provider write, and its receipt offers undo. FULI does not stop it on its way to the Provider.

### Receipts and undo

A review applied this way reads 「由 <模型名> 自动执行 / Executed automatically by <model>」 in Tonborg's workbench. Undo is offered only for an applied review whose knowledge was not permanently deleted. It removes only that review's AI marks. The Provider locks the item before it checks it, so an undo asked while an edit or later review of the same item is still being written waits for it and then judges what it left. When the person changed the item after the review (an edit, a new version, or a later review), the Provider refuses and the receipt says 「无法撤回：已被修改」; when the item was permanently deleted, FULI refuses before sending anything and says 「无法撤回：已删除」. A refused undo changes nothing and nothing is brought back. This operation has no effect outside FULI, so there is nothing external to roll back.

### Suggestions in the console

A review the host did not apply (`ai_suggested`) is also listed under Settings → 模型与用量 → 「建议记录」, beside what Astro, Bole and Jefa suggested (rec#8). Each row shows the item's title, the model's own conclusion and reason, why it was left to the person (the host's interceptions in plain words, such as 「模型把握不足」 or 「你选了「只给建议」」), who answered (the model, or 「当前会话」) and when. Its one action, 「查看知识条目」, opens the item in 知识整理, where the person confirms, edits or corrects it as for any item; the row itself applies nothing. Like the rest of that section it is what Tonborg said at the time, not a to-do: an older suggestion for the same item in the same project reads 「已有更新」, and the item shows whether it still waits. The console reads the newest 50 at `GET /api/judgment/suggestions?personalSpaceId=` (`src/judgment/review-suggestions.js`). That route is guarded like every full judgment read, and from 0.22 needs the console session `fuli open` starts (「Console trust boundary」 below): a verdict keeps the item's title and key from when Tonborg read it, the item may have been given to one FLA since, and the model's reason was written with Tonborg's scoped preferences, memory and earlier feedback in the same request. There is no filtered view for anyone else, and no MCP or Agent tool reaches the route. The page drops a shown list when a refresh is refused or fails, and when the active space changes or is lost, cancelling a read still under way. A permanently deleted item keeps its row without its words or a link.

### Local evaluation line

If the Tonborg review evaluation was recorded on this computer for the configured model at its configured endpoint (`node acceptance/tonborg-review-eval/score.js … --record <data dir>/model-evaluations.json`), the card shows one line naming the case set, the day and the model, for example 「本机评测 2026/10/22 · tonborg-review-eval/holdout · qwen3.5:4b · 一致率 44%（不代表普遍准确率）」. Without such a result the line is absent. The result changes what the page says only; it neither allows nor blocks anything.

The earlier per-build registry (`tonborg-review-gate.json`, rec#10 D-24) is no longer read. FULI never wrote it, so no installation loses a choice.

## What a decision does

Knowledge review uses bounded batches and an independent review ledger. A successful assessment appears as **Tonborg reviewed**. It does not change human confirmation, authoritative-source confirmation, publication eligibility, or the original evidence. The Provider compares an evidence snapshot within the write transaction; edited or conflicted knowledge loses its effective AI-reviewed disposition. A failing item cannot block the rest of the queue.

`assess_agent_action` recommends continuing the current conversation, reusing an authorized conversation, opening a session, or delegating work. It selects only registered, authorized, preflighted executors and available models that satisfy the Agent, assignment, task, and user routing constraints. The host performs and reports the actual launch or resumption. Conversation history is supplied only to a judgment client permitted for that Agent.

`assess_task_completion` is called by the accountable lead with its current task context, exact task revision, and artifact revision. Automatic acceptance requires a passed real verification by another Agent. The Provider rechecks the current lead context, task revision, artifact, and verified attempt before completing the FULI task. Jefa's separate human acceptance, publication, permissions, and payments retain their existing boundaries.

The console processes bounded automatic review batches while running. Manual review is available in Tonborg's workbench. Other MCP processes share the same local policy and decision database without starting duplicate schedulers. A lease prevents simultaneous decisions for the same project.

## Correct a judgment

Use thumbs up or thumbs down with an optional reason. A vote takes one click; reasons can be changed or cleared. The original decision, execution receipts, and feedback history remain auditable. Relevant feedback includes the selected client/model and work kind, so a reasonless vote still identifies the choice being evaluated. Feedback is scoped evidence for later decisions, not a new universal instruction or automatic reversal of an action.

Tonborg uses only its own scoped memory and authorized evidence. Client failure, malformed output, stale evidence, or missing authority produces a visible failure or escalation rather than a successful execution claim. Its judgment subprocess has no task tools or MCP access.

## Interfaces

The MCP tools are `get_judgment_policy`, `list_judgments`, `review_with_tonborg`, `assess_agent_action`, `assess_task_completion`, `get_agent_pins`, and `pin_agent`. Autonomy changes and feedback remain local user operations, and so do a role's 「只给建议」 switch and the acknowledgement of its warning (`PUT /api/model-backends/roles/:role/trust`, loopback only) and the undo of an automatic review (`POST /api/judgment/undo`); `GET /api/model-backends/roles` shows each role's `trust` read-only. Agent entry context supplies the current policy and workflow guidance; existing sessions should reconnect to discover newly installed tools.

### Console trust boundary

From 0.21 every console route that answers with Tonborg's full records or a model's free text works like the console's other full reads (knowledge details, session records) (rec#11 D-60):

- `GET /api/judgment/records` (records, receipts, feedback reasons and the questions for the person);
- `POST /api/judgment/feedback`, `POST /api/judgment/review`, `POST /api/judgment/assess` and `POST /api/judgment/accept`, which answer with the full records they wrote or ran;
- `GET /api/judgment/suggestions` (above);
- `GET /api/model-backends/suggestions`, the built-in Agents' suggestion log (docs/employee-agents.md).

Each answers only a loopback request. A request from another device is refused with `local_user_only`, even when LAN access is on and it carries a valid LAN code. Then the console server confirms its own human-review proof with the Provider through the owner-read port (`src/knowledge-owner-reads/owner-proof.js`, one bounded read whose answer is not used), before anything is read, run or written. The HTTP caller does not supply that proof: the server reads the token from its data directory's provider env and attaches it itself. Without that port or token the route answers 403 `human_review_proof_required`; a proof the Provider refuses is refused as the Provider answered. A refused request gets no data, and a refused feedback, review or assessment changes nothing.

Agents keep their own tools (`list_judgments`, `review_with_tonborg`, `assess_agent_action`, `assess_task_completion`), and no MCP or Agent tool module imports these routes or the proof check (`test/judgment-console-owner.test.js`). `GET /api/agent-pins` and `GET /api/judgment/policy` hold no history and stay as they were.

#### Console session (0.22, rec#11 D-61)

The server attaches the proof itself, so before 0.22 any local process could read the full history over loopback HTTP without reading any token, an Agent with a shell included. From 0.22 everything that returns full history or private content, or changes real data or where it goes, serves only a browser that `fuli open` signed in. That covers reads beyond what an Agent reaches with its own token and tools, whether on the human-review channel or under the owner's own authority.

- **Per launch.** Each console start makes a random secret (`crypto.randomBytes`) that stays in the server's memory. It is never written to disk, logged or put in a URL. Two credentials are derived from it, and the next launch has new ones:
  - an `HttpOnly; SameSite=Strict; Path=/` cookie named `fuli_console_<port>`;
  - a session token.
- **Why two.** A cookie is not isolated by port: the browser also sends it to any other port on `127.0.0.1`, where a local process could collect it. The token is kept in the console page's `localStorage`. That storage belongs to this origin (scheme, host and port), so another port cannot read it. Every console request sends the token as `x-fuli-console-session`, and protected requests need both credentials, each compared in constant time. A custom header from another origin needs a CORS preflight. The console never grants one: another origin's preflight gets 403 with no `Access-Control-*` headers.
- **Sign-in.** `fuli open` (and `fuli start --open`, `fuli restart --open`) asks the running console for a sign-in at `POST /api/console-session/codes`.
  - The request is loopback only and sends the data directory's human-review token in a header.
  - The console makes a one-time code: 32 random bytes, works once, expires after 60 seconds, and is compared in constant time against every waiting code.
  - It writes the code into an owner-only launcher file (`0600`, in a `0700` directory under the system temporary directory) and answers only that file's path. `fuli open` opens the file, as Jupyter does, so the code is never on a command line, where other processes (on Linux, other accounts too) could read it.
  - The file sends the browser to `/auth/console#code=…`. A browser never sends a fragment to a server or in a Referer.
  - That page takes the code out of the address bar at once and redeems it with a same-origin `POST /api/console-session/sign-in`. The answer sets the cookie and returns the token and the landing path. The page stores the token and replaces itself with the landing page.
  - The console deletes the launcher file once its code is redeemed or expires, and its directory when it stops. Neither the code, the cookie nor the token is ever logged, and `fuli open` prints only the console address.
- **Landing page.** `fuli open --next /knowledge?item=…` lands on that page after sign-in.
  - The path is checked when the code is issued, then checked again after normalizing: `/..//host` and `/%2e%2e//host` normalize to `//host`.
  - Only a same-origin console path is accepted. A scheme, `//host`, `/\host`, control characters, `/api/…` and `/auth/…` are refused (`src/console-session/next-path.js`).
  - The path is kept with the code, so no link can choose where a sign-in lands. The page also refuses an answer that would leave the origin.
- **Another site.**
  - **Redeeming:** only the console's own page can redeem a code. A request from another origin, or with `Sec-Fetch-Site` `cross-site`, is refused by the request policy before its body is read. A `same-site` request (another port of this host without an `Origin`) is refused with 403 and its code is burned.
  - **Codes in URLs:** a code in a URL's query is not how a sign-in works. Any request naming one, a link or a subresource from anywhere, burns it before the request policy answers.
  - **Login CSRF:** the code reaches a page only through the owner-only file, so a page of another site cannot hold one unless a local process of this account gave it away. Even then a forced sign-in would give that page nothing: there is one person per console, the cookie is HttpOnly, and the token stays in this origin's storage.
  - **Links from other sites:** a console page opened from another site's link still loads as the static console (rec#40 A1). Its own requests are same-origin and carry both credentials once this browser is signed in.
- **What needs it.** A request without both credentials of this launch gets 401 `console_session_required` (`src/console-session/session-ports.js`). That includes no cookie, a wrong one, another port's, one of an earlier launch, or the cookie without the token. Nothing is sent, read, run or written.
  - **Human-review ports:**
    - the full reads through `src/knowledge-owner-reads/console-port.js`: the owner proof of every route listed above, the graph, an item's view, a turn's full receipt, session records and what a session holds for a migration, the writing-taste profile, preference conflicts with their defer and completion, and the personal publication review with its decisions;
    - a permanent delete (preview, confirm, status);
    - where knowledge applies (one item, a session's batch);
    - tag changes and the tag reads across projects;
    - the undo of Tonborg's automatic review.
  - **Owner-authority routes:**
    - `POST /api/agent-conversations/query`, which reads every client's conversations, full messages included, and `PUT /api/agent-conversations/policy`;
    - an Agent's private working memory, `GET /api/project-agents/:agentId/memory`, and its export, `GET /api/project-agents/:agentId/memory/export`.
  - **Writes:**
    - confirmed data-format migrations and their undo, `POST /api/data-format/apply` and `POST /api/data-format/rollback`;
    - a built-in Agent's model settings and its 「只给建议」 switch, `PUT /api/model-backends/roles/:role` and `PUT /api/model-backends/roles/:role/trust`. These decide where its model calls, and the content in them, go.
  - The LAN refusal above still comes first, and the Provider still checks the proof. Another device never gets a session, because sign-ins are issued and redeemed only over loopback. On a LAN device the page says that full records show only in the console on the computer running FULI; it does not tell that device to run a command.
- **The page.** A refused read shows a one-line reason where it was asked. The top bar shows one notice with the command to run, for example `fuli open --next "/knowledge?item=…"`. The notice clears when the same read succeeds. If this origin's storage cannot be used, the sign-in page says so, and protected reads keep showing the notice. The page never redirects or retries by itself.

Unchanged, without a session (none of these returns protected history):

- `/api/health`, `/api/state`, system settings and runtime leases;
- capture, recall and Agent access policy;
- `/api/agent-pins`, `/api/judgment/policy`;
- model roles, usage and settings history;
- Agents' profiles, tasks and schedules, the roundtable;
- data-format status and preview;
- every static page.

These answer what an Agent with the Provider's Agent access token could also read.

Every way of opening the console signs in this way, or lands on a page that says to run `fuli open`:

- **`fuli open` and `fuli start/restart --open`:** they sign in.
- **The Windows tray** ("启动并打开" and a left click) and the portable `仅打开 Fuli.cmd` and `启动并打开 Fuli.cmd`: they run `fuli open`.
- **On macOS:** there is no separate app; use `fuli open`.
- **The end of `fuli setup`:** it prints `Open: run fuli open (console at …)`.
- **Receipt links, issue links, notification links and settings links:** they are plain console pages. They show their full content once this browser is signed in in this launch; before that, they show the notice.

A console restart, including a settings change that restarts it, starts a new launch. Run `fuli open` again after it. If a console is too old to sign in, or has no human-review channel, `fuli open` still opens it without a session and says why.

**Known limit: same OS account.** This raises the bar; it does not isolate. Signing in needs what the human-review channel needs: read access to the data directory's provider env. Any process of the same OS account can read that file, the launcher files and the rest of the data directory (graph files included), and can drive a browser. True isolation needs the operating system: a different account or a sandbox. What the session closes:

- the path that needed no token at all: a plain loopback HTTP request with only a `Host` header;
- collecting the session cookie on another local port;
- reading a sign-in code from a command line (`test/console-session.test.js`).
