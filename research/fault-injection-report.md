# Fault-Injection / Crash-Recovery Verification Report

> **Focus:** "尤其关注崩溃恢复过程中产生重复执行或丢失消息的风险" — the risk of
> **DUPLICATE EXECUTION** or **LOST MESSAGES** during crash recovery.
> **Harness:** [`scripts/fault-injection.mjs`](../scripts/fault-injection.mjs) —
> run with `node scripts/fault-injection.mjs`.
> **This is additional, empirical verification** (not a restatement of the existing
> 98 vitest tests). Every verdict below comes from actual harness output; nothing is
> asserted from reading the source alone.

---

## 0. Honesty / scope statement

- The harness was **executed 3 times BEFORE the fixes** (runs 1–3). All **9 scenarios
  ran to completion on every run**, the process always **exited 0**, and the verdicts
  were identical: **8 PASS, 1 CONFIRMED BUG** (`{"PASS":8,"BUG":1}` = S6/F1).
- **AFTER the minimal code fixes** (see §0.1 below) it was re-run against a fresh
  `pnpm run build`: **9 PASS, 0 BUG** (`{"PASS":9}`). The S6 scenario was rewritten
  to assert the NEW expected behaviour (second instance refused by the owner lock),
  and an extra stale-lock takeover check was added. The original pre-fix evidence is
  retained below because it is the reproducible proof of the bug that was fixed.
- **Non-destructive, verified:** each scenario creates a **FRESH
  `mkdtemp(os.tmpdir() + '/feishu-gw-fi-')`** directory and `rm -rf`'s it in a
  `finally` block. After 3 runs: `ls -d /tmp/feishu-gw-fi-*` → *(none)*.
  `git status --porcelain` after the runs shows only the two new deliverable files
  plus the two pre-existing untracked research files from other teammates — **no
  existing repo file was modified**, and nothing was written to `~/.dsh`,
  `/home/ubuntu/.dsh`, the web profile, the running Web GUI, real Feishu
  credentials, or production data. **No App Secret / credential was read or printed.**
- Only the documented public API was used (`createGateway`, `resolveConfig`,
  `MockFeishuTransport`, `MockSessionBridge`, `silentLogger`, `gw.start()` /
  `emitMessage()` / `whenIdle()` / `health()` / `stop()`).
- **No `*.test.ts` was added; `pnpm test`, `pnpm run build`, `dsh plugin`,
  `pnpm install` and all git mutations were NOT run.** `lib/` was used as-is (fresh
  build supplied by the task). `pnpm test` being green (98 tests) is task context,
  not something this report re-verifies.
- State-file names learned from `src/`: **`dedup.json`** (JsonStore, `seen` map),
  **`inbox.jsonl`** (append-only event log: `received` / `running` / `processed` /
  `failed` / `uncertain` / `recovery-notified`), **`outbox.json`**
  (`{pending:[{id,botId,target:{replyToMessageId,text,uuid},...}], sent:{id:ts}}`),
  **`sessions.json`** (chat→Session binding). The durable **inbox**, not the dedup
  cache, is the admission authority; `dedup.json` is non-authoritative.

### Where scenarios are NOT fully reachable via the public API (marked honestly)

- **S3** ("crash after reply sent but before `markProcessed`") cannot be *triggered*
  with the public API — there is no hook between `outbox.send()` and
  `inbox.markProcessed()`. It is **CONSTRUCTED** by removing the trailing
  `processed` event from a real, completed run's `inbox.jsonl` while leaving
  `outbox.sent` / `sessions.json` intact. The resulting on-disk bytes are identical
  to a real crash at that instant; the report labels this **state injection, not a
  triggered kill**. It is still an empirical observation of the recovery path.
- **S1 "rapid duplicate without id"** → **SKIP (sub-check)**: `emitMessage()` with
  no `messageId` makes `MockFeishuTransport` assign a fresh random id each call, so
  two no-id emits are two *distinct* Feishu events. A "true duplicate without an
  id" is not representable via this API. Observed and reported rather than faked.

---

## 0.1 POST-FIX RE-VERIFICATION (after the minimal code fixes)

The confirmed S6/F1 bug plus the F2 isolation gap were fixed with minimal code
changes (exclusive `.owner.lock`, per-instance `JsonStore` temp names, unbind of the
Session on `running → uncertain` recovery, JSONL tail normalization, stable `create`
UUID, `connected` only on WS readiness, rejection of inbound events after `stop()`).
`pnpm run build` was re-run, then `node scripts/fault-injection.mjs` was executed
again. Result: **exit 0, `{"PASS":9}`, 0 BUG**.

S6 after the fix (observed output):

```
[S6] Two gateway instances sharing ONE stateDir (F1)  =>  PASS
   ✓ second gateway on the SAME stateDir is REFUSED by the owner lock —
     gw2.start() error=Error: stateDir ... is already owned by a running
     Feishu gateway (pid ...); sharing one stateDir across instances would
     duplicate Agent execution
   ✓ stateDir carries an exclusive .owner.lock file
   ✓ exactly ONE Agent execution for the shared messageId (no duplicate) —
     b1.prompts=1 b2.prompts=0
   ✓ exactly ONE durable received event / ONE outbound reply
   ✓ a fresh gateway takes over the stateDir after the owner stops
   ✓ a NEW message is processed normally after takeover
   ✓ no leftover JsonStore temp files after ownership changes
   ✓ state JSON documents remain parseable
   ✓ inbox.jsonl lines remain individually parseable
   ✓ a stale owner lock from a dead process is taken over (restart not bricked)
```

The **F2** gap (uncertain turn kept its Session binding) is covered by a new vitest
integration test `isolates the Session of a crash-interrupted turn before the next
message`, which asserts the follow-up message creates a **fresh** Session rather than
resuming the interrupted one. The full vitest suite after the fixes: **14 files /
109 tests passed** (98 original + 11 new).

**Honest residual boundary after the fix:** admission is still an in-memory
per-instance Map, protected now by an **advisory, single-host** owner lock — not a
distributed mutex. `stateDir` must be local to ONE host and ONE gateway instance.
`uncertain`/`failed` remain terminal with no programmatic resolve/replay, admission
failures are invisible to `health()` counters, and exactly-once is still not
guaranteed across machine power loss (appendFile without fsync), beyond the bounded
20k `sent` ledger, or beyond Feishu's ~1h uuid window.

---

## 1. Environment

| Item | Value |
|---|---|
| Command | `node scripts/fault-injection.mjs` |
| Node | `v24.22.2` |
| Platform | `linux/x64` (Landlock sandbox, "partial enforcement / older ABI" notice) |
| UID | `1000` (`ubuntu`, **non-root** → `chmod 0o500` permission checks are genuinely enforced) |
| Working root | `/home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway` |
| Branch / commit | `fix/gateway-reliability-idempotency` / `75a5c3a` (read-only `git rev-parse`) |
| Run-1 UTC timestamp | `2026-11-14T12:14:17.936Z` |
| Build under test | prebuilt `lib/` (from `pnpm run build`, supplied) |
| Network / credentials | **none** — `offline:true`, `MockFeishuTransport`, `MockSessionBridge`, `silentLogger` |
| Temp state | fresh `mkdtemp` per scenario, `rm -rf` in `finally` |
| Config (per task) | `resolveConfig({ stateDir, allowlist:['ou_demo_user'], offline:true, sendRetries:1 })` |

**Injection techniques used:** `chmod(stateDir, 0o500)` (EACCES on durable append),
a `MockSessionBridge` with `delayMs` (blocking `waitForReply` → interrupted turn via
`gw.stop()` abort), a **genuine `SIGKILL` of a spawned child process** (`--crash-child`
mode, verified `childEvidence`), a torn JSONL tail, exact crash-window state
injection, two `createGateway()` instances on one `stateDir`, concurrent
`Promise.all` starts/emits, and `MockFeishuTransport({failSends})` (parked outbox
record).

---

## 2. Scenario-by-scenario results

Evidence below is from **run 1** (values such as UUIDs / timestamps are random per
run; structure and verdicts are identical in runs 2 and 3).

### S1 — Duplicate inbound delivery → **PASS**

**Method.** One fresh `stateDir`. Emit the SAME `messageId='s1-dup'` four times:
two sequential, then two concurrent ("rapid"); `whenIdle()`. Then `stop()` and
start a **brand-new gateway on the same stateDir**, re-deliver the same id. A second
fresh dir probes two no-id emits.

**Observed.**
- `bridge.prompts = 1` (`["s1-text"]`), `transport.sent = 1` (`["reply:s1-text"]`) for
  **4** deliveries — exactly ONE Agent execution and ONE reply.
- `health.processed = 1`, `inbox = {total:1, pending:0, done:1, failed:0}`,
  exactly **1** `received` event in `inbox.jsonl`.
- `dedup.json = {"seen":{"s1-dup":1794658457945}}`;
  `outbox.json = {"pending":[],"sent":{"idem:default:reply:s1-dup":1794658457950}}`.
- Restart + redeliver same id → `gw2 prompts=0`, `gw2 sent=0` (dedup survives restart).
- No-id emits → 2 DISTINCT generated ids (`om-bd9c00ac…`, `om-d0271607…`),
  `prompts=2`. **SKIP (sub-check)** with reason above (not a dedup failure; expected).

**Verdict PASS.** Within one instance, duplicate delivery of a stable `messageId`
does not duplicate execution; the idempotency key `reply:<id>` keeps the outbound
ledger at one entry. Duplicate delivery **after restart** is also suppressed.

---

### S2 — Crash AFTER durable admission, BEFORE the Agent finishes (CORE) → **PASS**

**Method (Part A, deterministic in-process).** `MockSessionBridge({delayMs:15000})`
blocks `waitForReply`. Emit `messageId='fi-crash-inflight'`. Poll until
`inbox.jsonl` contains `received`+`running` AND `bridge.prompts.length>=1`
(turn **admitted + submitted, never completed**). Then `gw.stop()` → abort;
`dispatch` returns via `if (signal.aborted) return` **without** `markProcessed`,
leaving the exact durable `running`-with-no-`processed` state a hard crash leaves.
Start a **brand-new gateway on the SAME stateDir**, emit a NEW distinct message.

**Method (Part B, genuine hard crash).** A spawned child (`--crash-child`) builds the
same in-flight turn, writes `_child_ready.json`, then stays alive; the parent
**`SIGKILL`s it** (no `stop()`, no `dispose`, no flush). `childEvidence` =
`{"ok":true,"prompts":1,"hasRunning":true}`, `childStderr` empty. A fresh gateway
then recovers on the same `stateDir`.

**Observed (both parts).**
- Crash state `inbox.jsonl` events = `["received","running"]` — **no `processed`**.
  Part A turn was submitted (`prompts=["FI-CRASH-INFLIGHT-TURN"]`) but never finished.
- After restart: events =
  `["received","running","uncertain","recovery-notified","received","running","processed"]`.
  The interrupted record got **`uncertain` + `recovery-notified`**; the **only**
  `processed` event belongs to the NEW message (`fi-after-recovery`).
- **(a)** `gw2 prompts = ["FI-AFTER-RECOVERY-TURN"]` — the interrupted turn is
  **NOT re-executed** (no duplicate Agent prompt).
- **(b)** an `uncertain` event is present for `fi-crash-inflight`; it is never
  `processed`.
- **(c)** the NEW distinct message is processed normally:
  `sent` includes `"reply:FI-AFTER-RECOVERY-TURN"`, `health.processed=1`.
- No duplicate reply for the interrupted turn. Instead **one** diagnostic notice
  is sent (outbox key `recovery:fi-crash-inflight`, Chinese "此前请求…为避免重复执行…
  请检查 DSH 会话后决定是否重新发送"), and the human must decide whether to resend.
- **Secondary observation (F2 residual risk):** recovery does **NOT** unbind the
  Session. The follow-up message **resumed the old sessionId**
  (`feishu-default-oc_fi_chat-session-4a55d0c3-…`; `gw2.resumed=[that id]`,
  `gw2.created=[]`) that was live during the crashed turn.
- Part B (SIGKILL child) reproduced **all** of (a)/(b)/(c) identically.

**Verdict PASS.** This is the core **conservative-recovery claim**: an interrupted
turn is never auto-replayed (protects against duplicate Agent side effects), while a
NEW message after the crash still works (no dead gateway). Confirmed with **two
independent crash methods**, including a real OS-level kill.

---

### S3 — Crash AFTER reply sent, BEFORE `markProcessed` → **PASS** *(constructed window)*

**Method / reachability.** Run a message to completion (`reply:s3-text` delivered,
uuid `fg-3461a401-…`, `outbox.sent={"idem:default:reply:s3-msg":1794658458139}`).
`stop()`, then construct the crash window by **removing the trailing `processed`
event** from `inbox.jsonl` (keeping `outbox.sent` + `sessions.json`). Crash state =
`["received","running"]`. Start a fresh gateway on the same `stateDir`.
*(The public API has no hook to fail at that exact instant — see §0.)*

**Observed.**
- Restart does **NOT re-execute the Agent**: `gw2 prompts = []`.
- Restart does **NOT re-send the same reply**: `gw2 sent` =
  `["此前请求在服务重启时处于执行中…"]` (one recovery diagnostic, **not**
  `"reply:s3-text"`). Original uuid `fg-3461a401-…` is **not** re-emitted;
  the diagnostic carries a NEW uuid `fg-61290c04-…`.
- `outbox.sent` after restart =
  `{"idem:default:recovery:s3-msg":1794658458148,"idem:default:reply:s3-msg":1794658458139}`
  — the **original reply idempotency key is unchanged**; the diagnostic uses a
  distinct key (`recovery:s3-msg`).

**Verdict PASS** (behavioural checks on the constructed state). There is **no
duplicate execution and no duplicate send of the original reply**. Honest nuance:
because the record becomes `uncertain`, the user gets a recovery notice and may have
to **manually resend** — i.e. the reply is effectively "on hold" rather than
silently duplicated or silently lost.

---

### S4 — Truncated JSONL tail → **PASS**

**Method.** Pre-write `inbox.jsonl` = 2 valid events (`received` for `s4-valid`,
`processed` for it) **plus a torn final line**
`{"type":"running","messageId":"s4-va` with **no trailing newline**. `start()`,
then emit a NEW message, then read the file back and `JSON.parse` every line.

**Observed.**
- `start()` **did not throw**. The torn tail was truncated away
  (file tail ends `…"attempts":0}}\n{"type":"processed","messageId":"s4-valid"}\n`).
- Valid records preserved; `0` parse errors after start; the `done` record was
  **not** replayed (`prompts=0`) — only `pending` work is replayed.
- After the subsequent append: `5` lines, **every line `JSON.parse`-able**
  (`parseErrors=[]`), **no glued `}{` objects**, events =
  `["received","processed","received","running","processed"]`.
- NEW message processed normally (`prompts=["s4-new-text"]`).

**Verdict PASS.** A torn tail neither crashes startup nor concatenates a later
append into an unparseable line (no silent corruption / no lost valid records).

---

### S5 — Admission persistence FAILURE → **PASS**

**Method.** Fresh `stateDir`, `start()` (after start only `dedup.json` exists;
`inbox.jsonl` absent). `chmod(stateDir, 0o500)` **after** start (start itself
writes `dedup.json` via `dedup.prune()`). Then `emitMessage()`.

**Observed.**
- `emitMessage()` **REJECTED**: `EACCES: permission denied, open
  '/tmp/feishu-gw-fi-ZxXewx/inbox.jsonl'` — the durable admission append failed.
- No durable admission: `inbox.jsonl` still absent; `dedup.json={"seen":{}}`
  (dedup was never reached).
- `health()` after: `processed=0`, **all `rejected` counters 0**, `errors=0`,
  `inbox.total=0` — i.e. the message was **NOT silently acknowledged-and-lost**:
  the inbound path THROWS, so the Feishu long-connection handler would withhold the
  200 ACK (Feishu redelivers).
- **Observability caveat (honest):** `health()` shows **no increment in any counter**
  for this failure. The error is surfaced only as the rejected `emitMessage`
  promise; a health()-only monitor would see nothing. This is a real (minor)
  visibility gap, not a silent ACKing.

**Verdict PASS** (with the observability caveat noted).

---

### S6 — TWO gateway instances sharing ONE `stateDir` → **BUG (CONFIRMED, F1 HIGH)** *(PRE-FIX evidence; now FIXED — see §0.1)*

> **This section records the pre-fix reproduction that motivated the fix.** After
> the fix the same scenario is a PASS (owner lock refuses the second instance).
> Kept verbatim as the reproducible proof of the original defect.

**Method (Part A, deterministic).** `createGateway()` twice on the SAME `stateDir`,
each with its own transport + bridge. `start()` both (sequentially), emit the SAME
`messageId='s6-shared'` to **both** (sequentially, with `whenIdle()` between to
avoid outbox temp noise), count `bridge.prompts` across both bridges.
**Method (Part B, concurrency).** `Promise.allSettled` of both `start()`s and both
`emitMessage()`s to probe `${pid}.tmp` temp-file collisions.

**Observed (Part A).**
- `b1.prompts=1`, `b2.prompts=1` → **total=2 Agent executions for ONE message_id**
  (**DOUBLE EXECUTION**).
- `inbox.jsonl` has **2 independent `received` events** for `s6-shared`.
- `t1.sent=1`, `t2.sent=1` (duplicate outbound replies).
- `gw1.health().processed=1`, `gw2.health().processed=1` — **each instance believes
  it is the sole owner**.

**Observed (Part B, reproduced in all 3 runs).**
- `startErrors=["Error: ENOENT: no such file or directory, rename
  '/tmp/feishu-gw-fi-SWQ084/dedup.json.995505.tmp' -> '.../dedup.json'"]` —
  a **real temp-file collision**: both instances live in the SAME process (same
  `pid`), so `JsonStore.writeToDisk`'s `"<file>.<pid>.tmp"` path is **identical**;
  one `rename` observed the other's already-renamed temp. This made `gw2.start()`
  throw, and the follow-up `emitMessage` to gw2 failed with
  `"transport is not connected"` → a **lost inbound event / startup failure** as
  well. `leftover .tmp=[]`, `inbox lines=3`, all state JSON still parseable.
- The double-execution in Part A was **deterministic (3/3 runs)**. The temp
  collision was **observed in 3/3 runs** but is inherently a timing race; the
  structural cause (shared `pid.tmp` name) is unconditional.

**Verdict — 🐞 CONFIRMED BUG (F1 HIGH).** `recordIfAbsent()` checks only the
**instance-local** `Map` + `serialize` chain. There is **no single-owner lock / no
cross-instance uniqueness check**. Sharing `stateDir` downgrades admission from
*at-most-once* to *at-least-once with duplicate Agent execution*, and the shared
`${pid}.tmp` temp name can clobber `rename`s. This is exactly the duplicate-
execution risk the user asked about, and it **does reproduce**.

---

### S7 — Rapid burst ordering + dedup → **PASS**

**Method.** One fresh `stateDir`. `Promise.all` of **8 rapid `emitMessage`s** to the
same chat: 5 unique ids (`b1..b5`, texts `seq:1..seq:5`) + 3 duplicate ids with
`…-DUP` texts. `whenIdle()`.

**Observed.**
- `health.processed=5`, `bridge.prompts=5` — **no lost messages, no duplicates**
  (5 unique ids, each executed once).
- No `DUP` text executed (first admission wins):
  `prompts=["seq:1","seq:2","seq:3","seq:4","seq:5"]`.
- **Per-chat ordering:** `prompts == durable admission order ==
  ["seq:1".."seq:5"]`; outbound `sent ==
  ["reply:seq:1","reply:seq:2","reply:seq:3","reply:seq:4","reply:seq:5"]`
  (per-chat FIFO preserved).
- `inbox.jsonl` = 5 `received` + 5 `processed` events;
  `dedup.json` has exactly 5 ids.
- Ordering assertion held in **3/3 runs**.

**Verdict PASS.** Under a rapid burst, no message is lost, no message is executed
twice, and per-chat reply order is preserved.

---

### S8 — Outbox UUID / idempotency-key stability across restart → **PASS**

**Method.** Fresh `stateDir`, `MockFeishuTransport({failSends:5})` so the reply
send fails and the outbox **parks a pending record**. Capture it from
`outbox.json`. `stop()`, then a **brand-new gateway** on the same `stateDir` with a
working transport drains the pending record on `start()`. Finally
`simulateReconnect()` + re-emit the same id.

**Observed.**
- Run 1: `outbox.json.pending[0] = {id:"idem:default:reply:s8-msg",
  target:{replyToMessageId:"s8-msg",text:"reply:s8-text",
  uuid:"fg-75b23289-82ee-4d80-b857-9e344aa874e2"}, attempts:1,
  lastError:"Error: simulated Feishu send failure"}`, `sent:{}`; `t1.sent=0`;
  inbox `done=1` (turn completed; outbox owns the pending reply).
- After restart: delivered `uuid = fg-75b23289-…` — **unchanged across restart**;
  exactly **1** delivery total (`t1=0, t2=1`), **no duplicate send**.
- `outbox.sent = {"idem:default:reply:s8-msg":1794658458241}` — **idempotency key
  preserved**; `pending=[]`; `gw2 prompts=0` (**no Agent re-execution**).
- Reconnect drain + re-emit same id → `sent=1`, `prompts=0` (still no duplicate).

**Verdict PASS.** The per-reply `uuid` and the `idem:default:reply:<id>` key are
stable and survive a restart; a parked reply is drained exactly once.

---

### S9* (EXTRA) — Never-started `pending` work IS replayed → **PASS**

**Method.** Pre-write `inbox.jsonl` with a single `received`
(`status:'pending'`) event for `s9-pending` and nothing else — models a crash
**after durable admission but before the turn began**. Start a fresh gateway.

**Observed.** `prompts=["s9-pending-text"]` (replayed exactly once),
`sent=["reply:s9-pending-text"]` (message **not lost**), events =
`["received","running","processed"]`, `processed=1`, `inbox.done=1`.

**Verdict PASS.** This is the **other half** of the conservative-recovery boundary:
never-started `pending` work **is** replayed (avoids LOSS), whereas in-progress
`running → uncertain` work is **not** replayed (avoids DUPLICATE EXECUTION, S2).

---

## 3. Final summary table

| ID  | Scenario | Verdict | One-line evidence |
|-----|----------|---------|-------------------|
| S1  | Duplicate inbound delivery (same messageId, rapid + restart) | **PASS** | 4 deliveries → `prompts=1`, `sent=1`; dedup.json + `idem:default:reply:s1-dup` updated; restart redelivery → 0 |
| S2  | Crash after durable admission, before Agent finishes (CORE) | **PASS** | `running`→`uncertain` (no `processed`), NOT re-executed, NEW message processed; verified with stop()-abort **and** SIGKILL child |
| S3  | Crash after reply sent, before markProcessed (constructed) | **PASS** *(constructed)* | no re-execution, no re-send of original reply, uuid/idem key unchanged; one recovery diagnostic instead |
| S4  | Truncated JSONL tail | **PASS** | `start()` no-throw; torn tail truncated; 5 lines all parse; no glued `}{` |
| S5  | Admission persistence failure | **PASS** | `emitMessage` throws `EACCES`; `inbox.jsonl` absent; `health` processed/rejected/errors/inbox all 0 |
| S6  | Two gateway instances sharing ONE stateDir (F1) | **🐞 BUG (CONFIRMED, pre-fix)** → **PASS after fix** | PRE-FIX: **2 Agent executions + 2 replies for 1 id**; `${pid}.tmp` rename ENOENT collision; no owner lock. POST-FIX: second instance refused by `.owner.lock`, exactly 1 execution, stale lock taken over on restart |
| S7  | Rapid burst ordering + dedup | **PASS** | 5 unique → `processed=5`, `prompts=5`, per-chat FIFO preserved, dedup 5 ids |
| S8  | Outbox UUID / idem-key stability across restart | **PASS** | uuid `fg-75b23289-…` identical after restart, exactly 1 send, key preserved |
| S9* | EXTRA: never-started pending work IS replayed | **PASS** | pending `received` replayed → 1 execution + 1 reply, no loss |

**TOTALS (all 3 PRE-FIX runs):** `{"PASS":8, "BUG":1}`. Harness always exits `0`.
**TOTALS (POST-FIX run):** `{"PASS":9}` — see §0.1.

---

## 4. CONFIRMED BUG *(pre-fix; fixed)*

**S6 = F1 HIGH — sharing one `stateDir` breaks atomic admission and double-executes
an Agent turn.** Reproduced deterministically (3/3 runs): two `createGateway()`
instances on one `stateDir` each admitted the same `messageId` as `isNew=true`
(instance-local `Map`), producing **2 Agent executions and 2 replies** for a single
Feishu event — a real **DUPLICATE EXECUTION** with potentially irreversible side
effects. Additionally (Part B, 3/3 runs) the shared `"<file>.<pid>.tmp"` JsonStore
temp path caused a `rename … ENOENT` collision that made the second `start()` throw
and the second inbound event fail with `"transport is not connected"` — i.e. it can
also cause a **lost inbound event / startup failure**. No `flock` / lockfile /
`O_EXCL` single-owner guard exists. This matches
[`research/review-findings.md`](review-findings.md) F1.

Honest secondary findings (not labelled BUG, but real caveats):
- **F2 residual risk (observed in S2):** an `uncertain` turn keeps its chat→Session
  binding; the follow-up message **resumes** the old sessionId instead of
  isolating it.
- **S5 observability gap:** an admission-persistence failure is invisible to
  `health()` (no counter increments); it is only visible as the thrown
  `emitMessage` promise.
- **Conservative trade-off (S2/S3):** an interrupted turn is parked as `uncertain`
  with a human-in-the-loop notice; the original request/reply may need **manual
  resend**, so a reply is "on hold" rather than silently duplicated or silently lost.

---

## 5. Conclusion — duplicate-execution / message-loss risk during crash recovery

**Within a correctly-deployed, SINGLE-OWNER gateway instance, the empirical picture
is reassuring and the conservative-recovery design holds:**

- **Duplicate execution is prevented** on the inbound side: durable, authoritative
  `inbox.jsonl` admission + dedup suppress redelivery of the same `messageId`
  (S1, S7). A turn interrupted by a crash (`running`, never `processed`) is
  **never auto-replayed**; it becomes `uncertain`, a one-time diagnostic is sent, and
  a human decides (S2) — this specifically avoids replaying Agent side effects that
  may already have happened. Verified with both a graceful abort and a **genuine
  SIGKILL** child process.
- **Message loss is prevented** for work that never started: `pending` records ARE
  replayed (S9), torn JSONL tails are safely truncated and later appends remain
  well-formed (S4), admission failures **throw instead of ACKing** so Feishu can
  redeliver (S5), and outbox replies are durable + idempotent (S3, S8).
- **Outbound idempotency is solid:** `outbox.sent` ledger + a stable per-reply
  `uuid`. A crash after the reply was sent but before `markProcessed` does **not**
  re-send or re-execute (S3), and a parked outbox record survives restart with the
  **same uuid**, drained exactly once (S8). Rapid bursts show no loss, no dup and
  preserved per-chat order (S7).

**GUARANTEE BOUNDARY (stated honestly):** the *at-most-once* admission guarantee is
**in-memory and PER-INSTANCE**. It is **not** a cross-process / cross-instance
property. The moment `stateDir` is shared by two gateway instances or processes:

- the same `messageId` is executed **TWICE** → **DUPLICATE EXECUTION**
  (**S6, CONFIRMED BUG / F1 HIGH**), and
- the `JsonStore` temp name keyed only by `process.pid` collides within one process,
  which can also break startup and **drop an inbound event** (S6 Part B).

There is **no single-owner lock**. Additionally, the design deliberately prefers
"pause + ask a human" over automatic replay, so an `uncertain` turn's reply may be
effectively **held until a manual resend** (a usability/manual-recovery cost, not a
silent loss), and admission failures are not reflected in `health()` counters.

**Net answer to the user's concern:** for a single-owner deployment, crash recovery
**does not silently duplicate Agent execution and does not silently lose messages** —
it errs on the conservative side (quarantine the in-flight turn, replay only
never-started work, make outbound delivery idempotent). **The DUPLICATE-EXECUTION
risk was REAL and CONFIRMED (S6) as soon as `stateDir` is shared** — this was the
one concrete bug found by fault injection and it is now **fixed** (§0.1): the second
instance fails closed via an exclusive `.owner.lock`, `JsonStore` temp names are
per-instance, and crash/restart is not bricked by a stale lock. The manual-recovery
path (no programmatic resolve for `uncertain`/`failed`) plus the health()
observability gap remain honest, explicitly documented caveats. Long term, moving
admission authority to an on-disk uniqueness check / SQLite would remove the
per-instance in-memory Map entirely; today the lock is an **advisory single-host
guard**, not a distributed mutex.

---

## 6. Limitations of this verification

- Mocks only: `MockFeishuTransport` does **not** emulate Feishu server-side
  redelivery on a non-200 ACK, nor server-side `uuid` dedup. The claim "the SDK/Feishu
  would withhold the ACK / redeliver" for S5 and "uuid makes the REST retry
  idempotent" for S8 are **inferred from the code + docs**, not verified against a
  live tenant. No real credentials or network were used (by design).
- S3's crash window is **constructed state injection**, not a triggered kill (§0).
- S6 Part B's temp collision is a timing race; it reproduced in **3/3** runs but is
  not guaranteed on every conceivable scheduling. The double-execution (Part A) is
  deterministic.
- `S1` no-id "duplicate suppression" sub-check is **SKIP** (not representable).
- `pnpm test` / `pnpm run build` / `dsh plugin` were intentionally NOT run; `lib/`
  was the supplied fresh build.
