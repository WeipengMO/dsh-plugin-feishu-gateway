# Code review — PR #1 "fix: harden Feishu gateway durability, retries and native Session lifecycle"

**Reviewer:** code-reviewer (read-only, delegated)
**Branch / commit:** `fix/gateway-reliability-idempotency` @ `75a5c3a` (clean tree)
**Scope reviewed:** `git diff main..HEAD` (11 commits, 22 files, +541/-208), full current `src/`, `tests/`, `docs/`, `README.md`, `.gitignore`, `package.json`, and the installed `@larksuiteoapi/node-sdk@1.76.0` bundle (to verify ACK semantics). No source/tests/docs/config were modified; no builds/tests/installs/git mutations were run. No credential values are reproduced below.

## Method / honesty notes

- I read the current source rather than only the diff; line numbers below refer to the **current** files at `75a5c3a`.
- I inspected `node_modules/@larksuiteoapi/node-sdk/lib/index.js` (the installed 1.76.0) to confirm how the long-connection ACK works — this is client-side code only.
- I could **not** run the test suite (read-only mandate), so "reproduced" below means a deterministic reasoning/white-box repro, not an executed test. Where I could not confirm a behaviour (Feishu server-side redelivery, DSH `agents.resume` semantics, torn-write behaviour of Node `appendFile`), I say so explicitly rather than speculate.
- Severity reflects *reliability/correctness impact* combined with *likelihood*. Anything that requires a specific deployment is flagged as such.

---

## Findings

### F1 — HIGH — Sharing one `stateDir` across two gateway instances/processes breaks atomic admission and can double-execute an Agent turn (concern 1; §七 "多 Gateway 实例共享同一 stateDir 是否安全")

**Files:** `src/inbox/inbox.ts:39` (`private records = new Map`), `:50-54` (instance-local `serialize` chain), `:133-156` (`recordIfAbsent` checks only the instance-local map); `src/storage/json-store.ts:11` (instance-local `chain`), `:49` (`const temp = \`${this.file}.${process.pid}.tmp\``); `src/gateway.ts:84-95` (all four stores built from the same `config.stateDir`); `src/index.ts:89-112` (`apply` creates a new gateway per activation, no single-owner guard).

**Why it is real.** The entire dedup/admission authority is **in-memory per instance**: `recordIfAbsent` asks `this.records.get(messageId)` and only ever writes/reads its own `inbox.jsonl` via its own Promise chain. Two `FeishuGateway` objects (or two processes) pointed at the same `stateDir` each hold an independent `records` map; a single Feishu `message_id` delivered to both is admitted as `isNew: true` by **both**, persisted to the same append-only file (O_APPEND writes don't corrupt each other) and dispatched **twice** → two native Agent turns → duplicate, potentially irreversible side effects. Additionally `JsonStore.writeToDisk` uses a temp name keyed only by `process.pid`, so two instances **in the same process** share the exact same `.tmp` path and can clobber each other's `rename`, producing lost/torn `outbox.json` / `sessions.json` / `dedup.json`. There is no `flock`/lockfile/`O_EXCL` guard anywhere (verified by grep over `src/`).

**Repro idea.** Load the plugin into two profiles (or call `createGateway` twice) with the same `stateDir`, `emitMessage` one `message_id` into both transports, then count `bridge.prompts` — expect 2 instead of 1. For the temp-file collision, run two `DurableOutbox` instances in one process and interleave `send()`/`drain()`; the shared `${pid}.tmp` makes one `rename` observe the other's half-written buffer.

**Minimal fix.** Document + enforce that `stateDir` is exclusive to one gateway instance. Add a startup owner lock (e.g. `mkdir(stateDir/.lock, ...)` with `O_EXCL`/`flock`, or an advisory lock file) that fails closed. Make `JsonStore` temp names include a per-instance random token, not just `process.pid`. Long term: make admission authority a real on-disk uniqueness check (or SQLite) instead of an instance-local map.

---

### F2 — MEDIUM/HIGH — Crash/shutdown of an in-flight turn leaves the chat→Session binding intact; only timeout/error paths isolate the Session (concerns 6, 7, 12; §七 "Session 取消与解绑竞态")

**Files:** `src/gateway.ts:281-292` (timeout/cancel → `registry.unbind`), `:294-312` (catch → `registry.unbind`), `:246-247` (`dispatch` returns immediately on `signal.aborted`), `:148-172` (`stop()` never unbinds), `:315-337` (`ensureSession` resumes `existing.sessionId`); `src/inbox/inbox.ts:118-125` (running → uncertain, **no** registry change).

**Why it is real.** The isolation mechanism (`unbind` a chat→session mapping so the next message gets a fresh Session) is applied **only** to explicit timeout/cancelled and thrown-error paths. A graceful `stop()` aborts the `AbortController`; `waitForReply` resolves via `withTimeout`'s abort handler (`src/util/retry.ts:72-88`), `dispatch` hits `if (signal.aborted) return` (`:281`) and exits **without** `cancel`/`unbind`/`markProcessed`, leaving the Inbox record `running`. On restart `open()` converts it to `uncertain` and `start()` sends a recovery diagnostic (`:135-140`), but the `SessionRegistry` binding for `<botId>:<chatId>` is untouched. The very next user message therefore calls `ensureSession` → `get(key)` returns the **old** binding → `bridge.resume(oldSessionId)` — i.e. it resumes the same Session that was executing the interrupted (possibly side-effecting) turn, instead of isolating it. This is an asymmetry: a turn that *timed out* is isolated, a turn *killed by shutdown/crash* is not. Whether resuming an aborted turn is safe depends on DSH `agents.resume` persistence semantics, which I could not verify from this repo (it is a structural port, `src/session/dsh-session-bridge.ts:117-123`).

**Repro idea.** Start a turn with a long `replyTimeoutMs`; call `await gateway.stop()` while `waitForReply` is pending; create a new gateway on the same `stateDir`; emit a follow-up message. Assert `bridge.resumed[0] === bridge.created[0].sessionId` (old session resumed) rather than a new `create`.

**Minimal fix.** In `start()`, for every record that transitions `running → uncertain`, also `await this.registry.unbind(chatKey(record.botId, record.chatId))` (and ideally `bridge.cancel`/dispose that orphaned handle), so the next message creates a fresh Session. Alternatively quarantine the binding in `SessionRegistry` rather than deleting it, and have `ensureSession` skip quarantined bindings.

---

### F3 — MEDIUM — Cancelled/failed/abandoned `AgentHandle`s are never disposed until plugin stop (concerns 6, 10; §七 cleanup / state consistency)

**Files:** `src/session/dsh-session-bridge.ts:57-58` (`handles` / `turns` maps), `:100-115` (`create` adds handle), `:117-123` (`resume` adds handle), `:163-172` (`cancel` calls `agent.cancel` + `settle` but **does not** remove the handle), `:174-189` (`dispose()` is the only place `handles.clear()` + `handle.dispose()` happens); `src/gateway.ts:283`, `:302` (both call `this.bridge.cancel(...)` **without `await`** and without disposing the handle).

**Why it is real.** `cancel()` settles the turn and cancels the agent loop, but the `AgentHandle` stays in `this.handles` for the rest of the plugin's life. Every timeout, failure, or `resume`-fallback that rebinds to a new Session leaves the previous handle (and its event subscriptions) alive. `dispose()` only runs at `stop()` (`src/gateway.ts:162`), so within a long-running plugin with frequent timeouts these handles accumulate unbounded — a resource leak, and cancelled agents may keep running side effects until `agent.cancel` actually takes effect (it is fire-and-forget at the gateway). `tests/unit/dsh-session-bridge.test.ts:183-188` tests `cancel` but never asserts handle disposal.

**Repro idea.** Using `MockSessionBridge`/fake agents, drive N timeouts on one chat; assert `bridge['handles'].size` (or `fake.disposed.length` before `stop()`) grows with N and stays >1 until `dispose()`.

**Minimal fix.** Add `bridge.disposeSession(sessionId)` (or make `cancel` remove+dispose the handle) and `await` it at both cancel sites; keep `dispose()` as a safety net. Note `SessionBridge` (`src/types.ts:141-157`) currently exposes no per-session dispose, so the port must be extended.

---

### F4 — MEDIUM — `inbox.jsonl` corruption handling is incomplete: a completed-but-invalid line hard-fails startup with no quarantine, and a valid-JSON-without-newline tail is not normalised (concern 3 "JSONL 断尾恢复"; §七 "持久化失败导致状态不一致")

**Files:** `src/inbox/inbox.ts:99-117` (`open()` parse loop), `:112` (`if (index !== lines.length - 1 || text.endsWith('\n')) throw error`), `:113` (`truncate(this.file, validBytes)`), `:116` (`validBytes` accounting never adds a missing trailing `\n`), `:81-87` / `:151-152` (`appendFile(..., \`${JSON.stringify(event)}\n\`)`); `src/gateway.ts:105` (`await this.inbox.open()`), `:142-145` (open throws → `start()` throws); `src/storage/json-store.ts:34-43` (JsonStore *does* quarantine corrupt files, inbox does not). Docs `docs/ARCHITECTURE.md:161` claim "损坏的状态文件会被隔离成 `.corrupt-*` 并干净启动" — true only for the three JsonStore files, not the inbox.

**Why it is real (two distinct sub-cases).**
1. **Confirmed:** any non-final line that is invalid JSON (bit rot, manual edit, a torn write that left a complete-but-garbled line followed by later appends) makes `open()` `throw`, which propagates through `start()` and the Cordis `effect` (`src/index.ts:104-107`) — the plugin simply fails to load, with **no** quarantine/skip/log-and-continue path and no operator-facing recovery command. One bad byte = permanent outage until manual file surgery.
2. **Lower-confidence (state honestly):** a torn `appendFile` that wrote a **complete valid JSON object but dropped only the terminating `\n`** leaves the file ending in a bare object. `open()` folds it as valid and, because `validBytes` adds no `\n` for the final line (`:116`), **never re-adds a newline**. The next `appendFile` concatenates `}{"type":...}\n` on one line; the following `open()` then hits an invalid non-final line and throws (case 1). I could **not** confirm that Node's `appendFile` produces such a 1-byte-short torn write for these small payloads; but the code explicitly claims to "repair a truncated JSONL tail" (`tests/unit/inbox.test.ts:105`), and its two existing torn-tail tests (`inbox.test.ts:68-74,105-115`) only cover a *syntactically broken* partial line, not this case.

**Repro idea.**
- Case 1: write `<valid line>\nGARBAGE\n` to `inbox.jsonl`, construct `DurableInbox`, `await open()` → throws.
- Case 2: write `<valid received object>` with **no** trailing `\n`, `await open()` (succeeds, folds it), `await record(newMessage)`, then `await open()` again → throws on the concatenated line.

**Minimal fix.** After the fold loop, if the file is non-empty and does not end with `\n`, append exactly one `\n` (or `truncate` to `validBytes` and rewrite). For invalid completed lines, quarantine `inbox.jsonl` to `inbox.jsonl.corrupt-<ts>` (mirroring `JsonStore`) and start clean with a loud warning, or skip-with-counter. Add a small recovery/diagnostic command that reports and can resolve `uncertain`/`failed` records.

---

### F5 — MEDIUM — No timeout on outbox sends; one hung/failing bot blocks all bots' replies and the startup drain (concerns 4, 9; §七 "多机器人部分连接失败时的隔离", "内存锁是否覆盖全部异步操作")

**Files:** `src/outbox/outbox.ts:82-120` (`drainUnsafe` holds the single `serialize` mutex across the **whole** loop), `:91-99` (`withRetry(() => transport.sendText(...))` called **without** `signal` and with `isRetryable`/retries but no overall timeout); `src/channel/lark-transport.ts:152-168` (`sendText` → SDK REST call, axios has no default timeout); `src/gateway.ts:130` (`await this.outbox.drain()` inside `start()`), `:350-357` (reconnect fires `void this.outbox.drain()`); `src/util/retry.ts:25-44`, `:46-62`.

**Why it is real.** `drainUnsafe` iterates a snapshot of **all** pending records for **all** bots while holding the one outbox mutex. A single `transport.sendText` that hangs (stalled TCP, no axios timeout) or a bot with `retries × backoff` serialises the entire queue behind it — healthy bots' replies are head-of-line blocked, and because `start()` awaits `outbox.drain()` (`:130`), plugin startup (and pending-inbox replay at `:134`) is delayed too. `withRetry` is invoked without the `AbortSignal`, so `stop()` cannot abort an in-progress send either. The per-bot `continue` on missing transport (`outbox.ts:86-89`) prevents *crashes* but not *blocking*.

**Repro idea.** `MockFeishuTransport` whose `sendText` returns a never-resolving promise for bot A; enqueue a reply for bot B; observe B's `send()`/`drain()` never completes while A's is outstanding.

**Minimal fix.** Give every `sendText` a hard per-attempt timeout (`Promise.race` with a timer / axios `timeout`), pass `AbortSignal` into `withRetry`, and consider draining per-bot or bounding time spent per drain so one bot cannot starve the rest.

---

### F6 — MEDIUM — Whitelist revocation is only effective after a full reload/restart, and the dequeue recheck reconstructs a synthetic message that cannot re-validate persisted security fields (concern 8; §七 "Inbox/Outbox 状态转换一致性")

**Files:** `src/router/message-router.ts:28-30` (`this.allowlist = new Set(config.allowlist)` — a **snapshot** taken once); `src/gateway.ts:83` (`new MessageRouter(deps.config)`), `:250-259` (dequeue recheck builds a synthetic `InboundMessage` with **hard-coded** `chatType:'p2p'`, `senderType:'user'`, `messageType:'text'`); `src/inbox/inbox.ts:7-18` (`InboxRecord` persists **only** `messageId/botId/chatId/senderId/text/receivedAt/status/...` — no `chatType`/`senderType`/`messageType`); `src/index.ts:89-112` (`apply` builds config into a detached `resolveConfig` copy; no live update path).

**Why it is real.** `MessageRouter` captures the allowlist at construction and there is no `update`/hot-reload hook. Config changes therefore only take effect when the whole plugin is disposed and re-applied (a new gateway + new router). A message that is already queued/`pending` in the **currently running** instance is rechecked with the **old** allowlist — live revocation does **not** intercept it. `tests/integration/gateway.test.ts:216-235` only proves the **restart** case (new gateway with a different allowlist), which does work and is genuinely fixed. Additionally, because `InboxRecord` does not persist `chatType`/`senderType`/`messageType`, the dequeue recheck cannot actually re-evaluate those rules; it hard-codes them. This is safe *today* (the router admits only `p2p`/`user`/`text`), but it means the durable record loses security-relevant fields and replay can never re-apply a future tightened rule.

**Repro idea.** Start a gateway with `allowlist:['ou_alice']`; queue a `pending` record while the bridge is slow; mutate the running config's allowlist to remove `ou_alice` **without recreating the gateway**; let the queue drain → the message still executes. (Contrast: the restart-based test passes.)

**Minimal fix.** Make `MessageRouter` read allowlist through a getter/reference to mutable config (or add `updateConfig`), persist `chatType`/`senderType`/`messageType` in `InboxRecord`, and recheck against the *stored* values. Document that revocation requires a reload.

---

### F7 — MEDIUM — `uncertain`/`failed` are terminal with no manual recovery API; user messages can be permanently stuck (§七 "用户消息是否可能永久卡住", "uncertain 是否有人工恢复方式")

**Files:** `src/inbox/inbox.ts:182-188` (`pending()` returns only `status === 'pending'`; `uncertain()` filters `!recoveryNotified`), `:174-180` (`markFailed`/`markProcessed`), `:166-172` (`markUncertain`/`markRecoveryNotified`); `src/gateway.ts:134-140` (startup: only `pending` is scheduled; `uncertain` only gets a recovery diagnostic + `markRecoveryNotified`), `:294-312` (any thrown error → `markFailed` + "请检查 DSH 会话再决定是否重试" diagnostic), `:343-390` (`health()`/`diagnostics()` are **read-only**); `src/index.ts:98-102` (the exported `feishuGateway` service exposes only `health`/`diagnostics`/`config`).

**Why it is real.** The conservative recovery is a deliberate, documented trade-off (README.md:230,235): never auto-replay a turn that may have caused side effects. But the consequence is that a `failed` or `uncertain` record **never becomes `pending` again** and there is **no** method, CLI, or service to retry/resolve/acknowledge it. `uncertain()` stops reporting it once `recoveryNotified` is set, but the record remains `uncertain` forever and is counted in `stats().failed` (`inbox.ts:200`). `failed` records are not even diagnosed on restart. The only "recovery" is a human re-sending the message from Feishu, which creates a *new* `message_id`. So yes — a user message can be permanently parked. Docs `docs/ROADMAP-v0.2.0.md:104` explicitly lists "死信队列 + 手动重放入口" as v0.2.0 TODO, i.e. this is a known, acknowledged gap.

**Repro idea.** Force a transient `bridge.submit` failure (MockSessionBridge `failNext`); the reply is a "处理失败" diagnostic and the Inbox record is `failed`. Restart the gateway: `pending()` is empty, `uncertain()` is empty, no reply is re-sent, `health().inbox.failed === 1` forever. There is no exported way to clear/retry it.

**Minimal fix.** Add a bounded-attempt retry policy for `failed` (with a clear "no side effects yet" marker) and an explicit `resolve(messageId, 'retry'|'drop')` operation exposed through the `feishuGateway` service / a command. At minimum expose `listUncertain()`/`listFailed()` so operators can act.

---

### F8 — LOW/MEDIUM — Outbox `sent` ledger is bounded (good), but `pending` and `inbox.jsonl` are unbounded; no compaction/dead-letter (§七 "Outbox 发送记录是否无限增长", JSONL growth)

**Files:** `src/outbox/outbox.ts:100-108` (`boundedSent` keeps the 20,000 most recent `sent` entries — **good**), `:110-117`, `:86-89` (records for a bot with no transport are kept in `pending` forever); `src/inbox/inbox.ts:81-87`, `:151-152` (append-only, never compacted), `:39` (`records` in-memory map grows with every message ever seen, never pruned); `src/gateway.ts:195` (`this.dedupSnapshot += 1` is only a counter, unrelated).

**Why it is real.** The `sent` ledger is correctly capped at 20k, so it will not grow without bound. But `pending` is **not** capped: a reply for a decommissioned/disabled bot (no transport) is retried on every `drain()` and never dead-lettered, so `outbox.json` grows and every reconnect re-attempts it (see F5). `inbox.jsonl` grows with every event for every message forever (one `received` + ≥1 status event), and `DurableInbox.records` keeps all of them in RAM. `DedupIndex` (`src/inbox/dedup.ts:68-78`) prunes by TTL/maxEntries, but it is now non-authoritative, so pruning it does **not** shrink the authoritative inbox. `docs/ROADMAP-v0.2.0.md:107-108` lists "JSONL 压缩与数据保留策略" and "排队长度上限" as TODO.

**Repro idea.** Send 100k messages over a long-lived instance and observe `inbox.jsonl` size and RSS growth; disable a bot after a reply is parked and reconnect 100 times, observing `outbox.json` `pending` never shrinks.

**Minimal fix.** Compact `inbox.jsonl` (rewrite only terminal records + keep a high-water mark), prune `records` to terminal + recent, and add `maxAttempts`/dead-letter to the outbox.

---

### F9 — MEDIUM — A misconfigured bot (invalid `appId`) is falsely reported `connected`; partial-connect failure is not isolated (concern 9 "多机器人部分连接失败时的隔离")

**Files:** `src/channel/lark-transport.ts:96-101` (`appIdLooksValid` is only a **warn**), `:129-135` (`await this.ws.start(...); this.transition('connected')` — **unconditional**); `src/config.ts:134-176` (`resolveBotCredentials` only checks non-empty env values, does not validate the `cli_…` shape); `src/gateway.ts:360-367` (`health()` treats `state === 'connected'` as healthy); SDK `node_modules/@larksuiteoapi/node-sdk/lib/index.js:103037-103043` (`WSClient.start` logs `invalid appId` and **returns/resolves without connecting** when `!/^cli_[0-9a-fA-F]{16}$/.test(appId)`).

**Why it is real.** `resolveBotCredentials` accepts any non-empty `appId`; `LarkTransport.connect` only warns on a bad shape; the SDK's `start()` silently no-ops (resolves) for an invalid `appId` and never fires `onReady`; yet the plugin unconditionally calls `transition('connected')` at `lark-transport.ts:131`. Result: the bot is reported `connected`, `health()` returns `ok`/not degraded, and `onStateChange('connected')` triggers an outbox drain that will fail auth. For a **valid** `appId`, `start()` also resolves *before* the WS handshake completes (it kicks off `reConnect(true)` asynchronously), so this `transition('connected')` is premature even in the healthy case; the real readiness signal is `onReady`/`onReconnected`. The per-bot `try/catch` in `gateway.start()` (`gateway.ts:119-129`) isolates **thrown** connect errors, but not this silent no-op, so "A single bot's failure must not disable all other bots" is only half-enforced.

**Repro idea.** Configure a bot with `appIdEnv` pointing at `app_bogus` (non-`cli_`); call `connect`; assert `transport.state === 'connected'` and `gateway.health().status === 'ok'` even though no WebSocket exists and `onReady` never fired.

**Minimal fix.** Drop the unconditional `transition('connected')` after `start()`; rely on `onReady`/`onReconnected` for `connected`, set `connecting` until then, and treat `onError`/handshake-timeout as `failed`. Optionally fail closed in `resolveBotCredentials`/`buildTransports` on an invalid `appId` shape (or at least mark the transport `failed` so `health()` degrades).

---

### F10 — LOW — The `create` (chatId) send path ignores the persisted `target.uuid`, breaking its idempotency; the UUID regression test is a false positive (concern 5 "UUID 跨重试、跨重启的一致性")

**Files:** `src/channel/lark-transport.ts:163-167` (`create` uses `uuid: newId('fg')` — a **fresh** UUID on every call — instead of `target.uuid`), `:155-160` (`reply` correctly uses `target.uuid ?? newId('fg')`); `src/outbox/outbox.ts:66` (`target: { ...target, uuid: target.uuid ?? newId('fg') }` persists one UUID per record); `tests/unit/outbox.test.ts:92-106` ("reuses the original REST UUID after restart" uses the **create** path but the `MockFeishuTransport.sent` entry records the *target*, not the UUID actually passed to the REST API — `mock-transport.ts:54`). `src/types.ts:45-46` documents `uuid` as "stable per-message idempotency UUID reused on every REST retry".

**Why it is real.** In production `replyDiagnostic` (`gateway.ts:339-341`) always passes `replyToMessageId`, so only the `reply` path is used and the UUID **is** stable across retries/restarts (verified: persisted at `outbox.ts:66`, reused at `lark-transport.ts:157`, reloaded by `open()`). But the `create` path silently violates the documented contract: a caller sending by `chatId` gets a new `newId('fg')` on every `withRetry` attempt, so Feishu server-side dedup cannot work. The test that is supposed to guard this is a false positive: it checks `transport.sent[0].uuid` (the outbox record's field), which is stable regardless of what `sendText` actually sends.

**Repro idea.** Use the real `LarkTransport` (mocked SDK), call `sendText({ chatId, text, uuid: 'FIXED' })` twice with `failCreate` toggled, and inspect the mocked `create` payloads' `uuid` — both differ from `'FIXED'` and from each other.

**Minimal fix.** Use `uuid: target.uuid ?? newId('fg')` in the `create` path too; change the test to assert the UUID passed to `im.message.create`, not the one on the outbound target.

---

### F11 — LOW — `handleInbound`'s `if (this.stopped) return` ACKs an event without durable admission (concern 2 edge case)

**Files:** `src/gateway.ts:148-151` (`stop()` sets `this.stopped = true` **before** closing transports), `:176` (`if (this.stopped) return`), `:175-201` (`handleInbound`); `src/channel/lark-transport.ts:207-212` (`await onMessage(...)`, then re-throw on failure).

**Why it is real.** `stop()` sets `stopped = true` first, then `await transport.close()` for each bot (`gateway.ts:153-159`). During that window the WS may still deliver an event; `handleInbound` returns normally at `:176` **without** `recordIfAbsent`. `handleEvent` sees a resolved `onMessage`, the SDK sends `{code:200}` (`index.js:102944-102959`), Feishu considers the event consumed → the message is **lost** (no durable record, no replay, no redelivery). Normal shutdown is a narrow window, but it is a real hole in "先持久化再确认". The common case is fine (see "does correctly").

**Repro idea.** Trigger `stop()` and, before `close()` resolves, invoke the registered `'im.message.receive_v1'` handler; assert no `received` event was appended to `inbox.jsonl` while the handler resolved successfully.

**Minimal fix.** On `stopped`, reject (throw) from `handleInbound` so the SDK emits a non-200 and Feishu redelivers, or gate admission on `!stopped` at the very top of the handler and let the transport stop accepting events before setting the flag.

---

### F12 — LOW — Reply is sent (external side effect) before `markProcessed`; crash in that window produces a real reply **plus** a misleading "please resend" recovery message (§七 "持久化失败导致状态不一致")

**Files:** `src/gateway.ts:289` / `:275-292` (`replyDiagnostic` → `outbox.send` performs the REST send **before** `registry.touch` and `inbox.markProcessed` at `:291-292`), `:265` (`markRunning` **before** any agent effect — correct), `:135-140` (startup: `uncertain` → recovery diagnostic with key `recovery:<id>`), `:339-341` (recovery diagnostic uses a **different** idempotency key than `reply:<id>`).

**Why it is real.** If the process dies after the reply REST call succeeded but before `markProcessed`, the Inbox record is still `running` → becomes `uncertain` on restart. `start()` then sends a *second*, differently-worded message (`recovery:<messageId>`) telling the user the operation "可能已经产生实际操作…请检查 DSH 会话后决定是否重新发送", even though the actual answer was already delivered. The design correctly avoids **double Agent execution** (uncertain is never replayed) and avoids a **duplicate of the same reply** (the `reply:<id>` key is in `sent`), but the user still gets a confusing second message. The window is real though narrow; README.md:235 acknowledges "极窄的进程崩溃窗口".

**Repro idea.** Pause the process (or inject a crash) between `replyDiagnostic` resolving and `markProcessed`; restart; observe two messages for one inbound event.

**Minimal fix.** Mark `processed` (or an intermediate `replying` state) **before** the external send, or make the recovery diagnostic conditional on whether `reply:<id>` is present in the outbox `sent` ledger. A two-phase "reply committed" marker would close the window.

---

### F13 — INFO/LOW — Secrets vs. user content at rest; gitignore covers only the *default* state dir (§七 "日志/状态文件是否泄露 Secret 或用户内容")

**Files:** `src/inbox/inbox.ts:84,152` (`mode: 0o600`), `src/storage/json-store.ts:50` (`mode: 0o600`), `src/config.ts:178-189` (`redactedConfigSummary`), `src/channel/lark-transport.ts:101-108` (credentials kept in memory, never logged — verified), `tests/unit/config.test.ts:84-89,106-117`; `.gitignore` diff (adds `.feishu-gateway/` and `**/.feishu-gateway/`).

**Verified good.** No credential **values** are logged: `resolveBotCredentials` returns only `source` (`env:VARNAME`) and `missing` names; `redactedConfigSummary` emits `allowlistSize`, never `ou_*` ids; `buildTransports` logs the env-var **names**; `health()`/`diagnostics()` contain no secrets. I found no path that prints `appSecret`/`appId` values.

**Residual risk.** The state files contain **user message text and model reply text in plaintext** (`InboxRecord.text` in `inbox.jsonl`, `OutboundTarget.text` in `outbox.json`), plus `chat_id`/`message_id` identifiers. Files are `0o600`, but `stateDir` itself is created with default (`mkdir(..., {recursive:true})`, typically `0755`). `.gitignore` now ignores only the default `.feishu-gateway/` (and `$DSH_HOME/feishu-gateway` lives outside the repo anyway); a user who configures a **custom `stateDir` inside the repo** can still accidentally commit message bodies. This is inherent to a durable queue, but should be documented.

**Minimal fix.** Document that `stateDir` holds plaintext user content, create it `0o700`, and ignore any configured in-repo state path (or warn if `stateDir` resolves inside the workspace).

---

### F14 — INFO — `appendFile` is not `fsync`'d: "durable" means OS page cache, not disk (exactly-once boundary)

**Files:** `src/inbox/inbox.ts:84,123,152` (`appendFile`, no `fsync`/`fdatasync`); `src/storage/json-store.ts:50-51` (`writeFile(temp)` + `rename`, also no `fsync`). Docs `docs/ARCHITECTURE.md:159` describe writes as "原子" (atomic) — true for the `rename` path, not for durability against power loss.

**Why it is real (as a boundary, not a bug).** A *process* crash (SIGKILL) preserves data already handed to the kernel, so the JSONL replay works. A *machine* crash / power loss can lose the most recent unsynced append — e.g. lose the `running` event while keeping the earlier `received`, turning a started turn into a `pending` record that is **replayed on restart** → duplicate Agent side effects. This is the fundamental limit of the "durable execution boundary".

**Minimal fix.** `fsync` the file (and directory after `rename`) at the admission/running boundaries, or accept and document this as an explicit at-most-once-with-power-loss caveat (it is already implicitly acknowledged in README.md:235).

---

### F15 — LOW/INFO — Dead code / fire-and-forget in the cancel path (§七 "Session 取消与解绑竞态")

**Files:** `src/gateway.ts:282` (`reply.reason === 'cancelled'`), `:283`, `:302` (`this.bridge.cancel(...)` **not awaited**); `src/session/dsh-session-bridge.ts:148-161` (`waitForReply` returns only `'idle' | 'timeout' | 'empty'` — **never** `'cancelled'`), `src/types.ts:124` (`SessionReply.reason` includes `'cancelled'`).

**Why it is real.** With the real `DshSessionBridge`, `reason === 'cancelled'` is unreachable (only `MockSessionBridge.waitForReply` returns it, `mock-session-bridge.ts:63`, and even then `dispatch` returns early on `signal.aborted` at `:281` before checking the reason). So the `cancelled` branch is dead in production. Separately `bridge.cancel` is fire-and-forget at both call sites, so `unbind` / the next turn can proceed before `agent.cancel` has taken effect — mitigated by the fact that the next turn uses a **different** `sessionId` and `onSessionEvent` drops events whose turn was deleted (`dsh-session-bridge.ts:211-212,227-228`), but the old agent may still be winding down. Low impact.

**Minimal fix.** Remove the unreachable `cancelled` case (or make the bridge return it), and `await`/chain `cancel` where possible.

---

### F16 — INFO — Documentation overstates recovery; the gaps are already on the roadmap

**Files:** `docs/ARCHITECTURE.md:159` ("所有写操作都是『同目录临时文件 + `rename`』" — inbox uses `appendFile`), `:161` ("损坏的状态文件会被隔离成 `.corrupt-*` 并干净启动" — only JsonStore files), `:170` (`bridge.dispose()` → "每个 `AgentHandle.dispose()`" — true only for handles still in the map at stop, see F3), `:203-204` (honestly notes the SDK API shape "没有用真实凭据连过"); `docs/ROADMAP-v0.2.0.md:103-108` (explicitly lists ACK/3s re-push measurement, dead-letter+manual replay, JSONL compaction, backpressure as v0.2.0 TODO); `README.md:235` (honest exactly-once disclaimer).

**Why it matters.** The README/roadmap are admirably candid, but §2.3/§2.4 of ARCHITECTURE.md read as if corruption-quarantine and full clean-up are already in place; F3/F4/F7 show they are not. Aligning the docs prevents operators from assuming a recovery path that doesn't exist. `ROADMAP:103` is especially relevant: the authors themselves flag that "飞书 3 秒重推行为" is **unmeasured** — see the ACK note in "does correctly".

---

## Things the fix does correctly (state transitions verified)

These are confirmed by reading the code + the SDK bundle, not just assumed:

- **Inbox admission is atomic and authoritative within one instance.** `recordIfAbsent` (`inbox.ts:133-156`) checks the in-memory map and appends the `received` event inside one `serialize` critical section; concurrent deliveries are correctly deduplicated (`tests/unit/inbox.test.ts:75-87`). `DedupIndex` is now correctly demoted to a non-authoritative cache whose failure is swallowed (`gateway.ts:193-199`).
- **ACK is after durable admission, and failure re-throws.** `LarkTransport.handleEvent` `await`s `onMessage` and re-throws (`lark-transport.ts:203-212`). I verified in the installed SDK that `EventDispatcher.invokeWithHandle` `yield`s the handler (`index.js:101085`) and `WSClient.handleEventData` sets `respPayload.code = 500` on a thrown handler (`index.js:102948-102957`) before sending the ACK frame — so a persistence failure is **not** silently ACKed. `tests/unit/lark-transport.test.ts:174-178` covers this at the adapter level. *Caveat:* the SDK bundle is client-side only; I could **not** verify Feishu **server-side** redelivery on a 500 response, and the roadmap (`ROADMAP:103`) lists this as unmeasured. If Feishu does not redeliver long-connection events on non-200, the throw alone would not recover the lost message (the `stopped` early-return, F11, is a confirmed ACK-without-admission hole regardless).
- **`pending → running → done` ordering is correct.** `markRunning` is `await`ed **before** `bridge.submit`/any Agent effect (`gateway.ts:265,275`). Only `status === 'pending'` is replayed on restart (`inbox.ts:183`); `running` is folded to `uncertain` inside `open()` (`:118-125`) and **never** auto-replayed. This is the correct conservative boundary: a crash after admission-but-before-execution replays safely, a crash during execution does **not** double-execute. Verified against `tests/unit/inbox.test.ts:89-103,105-115` and `tests/integration/gateway.test.ts:237-258`.
- **Duplicate redelivery reschedules a stranded `pending` record without double dispatch.** `handleInbound` on `!isNew && status === 'pending'` calls `scheduleRecord` (`gateway.ts:186-191`), and `scheduleRecord`'s `scheduledMessageIds` set (`gateway.ts:204-215`) prevents the same `messageId` being dispatched twice within a process — this is exactly the `ab908a3` fix. Startup replay (`gateway.ts:134`) and inbound scheduling share that guard.
- **Per-chat serialisation is correct.** `enqueue` (`gateway.ts:222-232`) chains on `chatKey(botId, chatId)` with `.catch(()=>undefined)` so one failed turn doesn't poison the queue, and cleans up the map entry. Two rapid messages in one chat cannot interleave turns (`tests/integration/gateway.test.ts:105-115`).
- **Outbox concurrency / reconnect replay is correct.** `send`, `drain`, `clear` all funnel through one `serialize` mutex and `drainUnsafe` is only ever called with that mutex held (`outbox.ts:40-44,58-80,82`); concurrent `send()` + reconnect `drain()` cannot double-send. `onStateChange('connected')` triggers `drain()` (`gateway.ts:350-357`), and `start()` also drains (`:130`). `tests/unit/outbox.test.ts:66-90` cover concurrent sends/drains/duplicate keys.
- **Outbound UUID is stable across retries and restarts on the production `reply` path.** A single `newId('fg')` is persisted per outbox record (`outbox.ts:66`), reloaded by `open()` across restarts, and reused at `lark-transport.ts:157` on every `withRetry` attempt and reconnect drain. Idempotency key `idem:<bot>:reply:<messageId>` is derived deterministically from the inbound `messageId` (`gateway.ts:340`, `outbox.ts:60`). The `sent` ledger is bounded to 20k (`outbox.ts:100-104`). (The `create` path is the exception — F10.)
- **Session identity is stable across restarts.** `ensureSession` persists the full (random-suffixed) `sessionId` in `SessionRegistry` (`gateway.ts:315-337`), so `bridge.resume(existing.sessionId)` reuses it after restart (`tests/integration/gateway.test.ts:117-147`). Timeout/cancel `unbind`s the chat so a fresh Session is used (`gateway.ts:285`, `tests/integration/gateway.test.ts:260-285`) — late replies cannot leak into the next turn because `onSessionEvent` drops events for deleted turns (`dsh-session-bridge.ts:211-212`).
- **Whitelist revocation works after a restart.** The dequeue recheck (`gateway.ts:250-259`) runs for every `pending` record replayed at startup, so a revoked sender's queued message is `markProcessed` without execution (`tests/integration/gateway.test.ts:216-235`). (Limitation: live revocation — F6.)
- **Cleanup on `stop()` is mostly complete.** `stop()` aborts the controller, closes every transport via `WSClient.close({force:true})`, `await Promise.allSettled(inFlight)`, then `bridge.dispose()` which removes both `ctx.on` listeners and disposes every `AgentHandle` (`gateway.ts:148-172`, `dsh-session-bridge.ts:174-189`, `tests/unit/dsh-session-bridge.test.ts:190-200`, `tests/integration/gateway.test.ts:187-196`). `ctx.provide`/`ctx.effect` are fiber-owned (`index.ts:98-112`). (Gaps: F2/F3/F5 — reconnect drains are `void`-ed and not awaited by `stop()`; per-session handles not disposed at cancel.)
- **Fail-closed security.** Only `open_id` is accepted (`lark-transport.ts:186`), unknown `chat_type` is mapped to `group` and rejected (`:196`, `message-router.ts:33-36`), `sender_type === 'user'` and `messageType === 'text'` required, empty allowlist denies all, credentials must come from env (`:8c0cbc5`, `config.ts:134-176`). No secret values logged (F13).
- **Assistant text fallback.** `assistant/attempt` text is kept as a fallback without concatenating it with the final `assistant/message` (`dsh-session-bridge.ts:150-153,213-217`), and `whenIdle` only settles a turn when some content was observed (`:138-145`) — `9425522`/`52ff024` verified.

---

## §七 extra-concerns coverage

| Concern | Verdict |
| --- | --- |
| Inbox/Outbox 状态转换一致性 | Mostly consistent. Inbox: `pending→running→done|failed`, `running→uncertain` on restart — verified. Outbox: `pending→sent` with bounded ledger — verified. **Gap:** cross-store operations are not a transaction (reply sent before `markProcessed`, F12); `recoveryNotified` records stay `uncertain` forever (F7). |
| 内存锁是否覆盖全部异步操作 | `DurableInbox`, `DurableOutbox`, and each `JsonStore` have their **own** `serialize` chain — all their mutations are covered. But there is **no spanning lock/transaction** across Inbox+Registry+Outbox (F12), **no cross-instance lock** (F1), and `transport.sendText` has **no timeout** while holding the outbox mutex (F5). Reconnect drains are fire-and-forget (`gateway.ts:354`), not awaited by `stop()`. |
| 持久化失败导致状态不一致 | Yes, in narrow windows (F11, F12, F14). `markRunning` before effects and `uncertain` recovery prevent the *worst* case (double execution). |
| 用户消息是否可能永久卡住 | **Yes** — `failed`/`uncertain` are terminal with no retry/resolve API (F7). Documented as a deliberate trade-off, but still a real "stuck" state. |
| Outbox 发送记录是否无限增长 | `sent` is bounded (20k) — good. `pending` and `inbox.jsonl` are **unbounded** (F8). |
| uncertain 是否有人工恢复方式 | **No programmatic one.** Only a user re-send (new `message_id`) + read-only `health()`/`diagnostics()` (F7, F16). Roadmap lists a manual-replay entry as TODO. |
| Session 取消与解绑竞态 | `cancel` is fire-and-forget and does not dispose the handle (F3); crash/shutdown does **not** unbind (F2). Event-level isolation via deleted turns is correct. |
| 多 Gateway 实例共享同一 stateDir 是否安全 | **No** (F1). No lock, instance-local admission map, colliding `${pid}.tmp`. |
| 服务异常退出/重启是否可能重复执行不可逆操作 | Only via (a) multi-instance (F1), or (b) power-loss losing the un-`fsync`'d `running` event (F14). Normal process crash is handled correctly. |
| 日志/状态文件是否泄露 Secret 或用户内容 | No secret **values** logged (verified). State files hold plaintext user/reply text with `0o600` (F13). |
| exactly-once / 外部 API 幂等性保证边界 | See the explicit boundary statement below. |

---

## Prioritized list of top issues worth fixing

1. **F1 (HIGH)** — Add a single-owner lock / uniqueness guarantee for `stateDir`; otherwise two instances double-execute Agent turns. Highest blast radius because it can duplicate irreversible side effects.
2. **F2 (MEDIUM/HIGH)** — On `running → uncertain` recovery, also unbind/quarantine the Session so the next message does not resume an interrupted turn. Closes the isolation asymmetry between timeout and crash.
3. **F5 (MEDIUM)** — Add a hard timeout (and `AbortSignal`) to outbox sends; one hung bot currently blocks all bots' replies and startup.
4. **F4 (MEDIUM)** — Quarantine/ recover corrupt `inbox.jsonl`; normalise a missing trailing newline. Today one bad line = permanent startup failure.
5. **F6 (MEDIUM)** — Make whitelist revocation effective for already-queued messages (mutable config / persist security fields in `InboxRecord`).
6. **F9 (MEDIUM)** — Don't unconditionally report `connected`; a misconfigured bot is silently marked healthy.
7. **F3 (MEDIUM)** — Dispose cancelled/abandoned `AgentHandle`s at cancel/unbind, not only at plugin stop.
8. **F7 (MEDIUM)** — Provide a bounded retry + manual resolve/replay path for `failed`/`uncertain`; otherwise messages are permanently stuck.
9. **F8 / F10 / F12 / F11 / F13 / F14 / F15 / F16** — compaction/dead-letter, fix the `create` UUID path (and its false-positive test), reorder reply/markProcessed, reject events during shutdown, harden docs/permissions, `fsync`, remove dead `cancelled` code.

---

## Explicit exactly-once guarantee boundary

**This plugin does not, and cannot, provide end-to-end exactly-once.** Its actual, verifiable guarantee is:

- **Inbound admission** — *at-most-once per `message_id` within a single gateway instance* (durable `inbox.jsonl` + instance-local authoritative map, `recordIfAbsent`). Feishu delivery is *at-least-once* (long-connection redelivery on a non-200 ACK — the plugin correctly throws on persistence failure so the SDK emits `code:500`, but **Feishu server-side redelivery is assumed, not verified from the client bundle**, and the roadmap flags it as unmeasured). **Sharing `stateDir` across instances/processes downgrades admission to at-least-once with possible duplicate Agent execution (F1).**
- **Agent execution** — *at-most-once **automatic** execution*: `pending` records are replayed on restart, but anything that reached `running` becomes `uncertain` and is **never auto-replayed** (conservative, avoids double side effects). The cost is possible permanent loss (F7). This is **not** exactly-once: a machine/power crash that loses an un-`fsync`'d `running` event turns a replay into a double execution (F14). Non-idempotent DSH tool calls made *inside* the Agent are entirely outside the plugin's control.
- **Outbound reply** — *at-least-once delivery*, with **best-effort** dedup: (a) a local `sent` ledger bounded to 20,000 entries (so it is **not** a durable indefinite guarantee), and (b) Feishu's `uuid` idempotency key, which is a server-side, per-app, documented **~1-hour** dedup window. A reply parked for >1 hour, a `sent` entry evicted after 20k newer replies, or a crash between the REST send and `markProcessed` (F12) can produce a **duplicate or misleading second message**. The `create` path has **no** stable UUID at all (F10).
- **Crash windows** — `markRunning` precedes Agent effects (correct), but the reply is sent **before** `markProcessed`, and `appendFile` is not `fsync`'d. README.md:235 already acknowledges "网络发送成功与本地记录完成之间仍存在极窄的进程崩溃窗口… 不能跨任意下游工具保证严格 exactly-once".

**Boundary in one sentence:** the plugin guarantees *at-most-once automatic Agent execution* + *at-least-once reply delivery* + *best-effort external idempotency*, **within one single-owner process, across process (not machine) crashes, within Feishu's ~1h uuid window**. Strict exactly-once across multiple instances, machine/power loss, long outages (>1h), `sent`-ledger eviction, or non-idempotent Agent tool calls is explicitly **not** guaranteed.
