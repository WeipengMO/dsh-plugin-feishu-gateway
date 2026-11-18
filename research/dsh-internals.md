# DSH 0.2.2-rc.1 internals research — agent factory, SessionStore, persistence, headless

READ-ONLY investigation of the **real installed runtime**. No builds, boots, tests, installs,
or mutations were performed; only `ls`/`grep`/`sed`/`cat` and the read tool were used.
No credential/API-key values were read or reproduced.

## Path convention

- `$CORE` = `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
  (all `dsh-*`, `cordis/...` references below are relative to `$CORE`).
- `$DSH` = `/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh`
  (`dsh/lib/...` references are relative to `$DSH`).
- Repo references (`research/...`, `profiles/...`, `.tmp/...`) are relative to the working
  directory `/home/ubuntu/dsh-workspace/projects/dsh-plugin-feishu-gateway`.

Every claim below carries a `file:line`. Where I could not confirm something from source
alone, it is explicitly marked **UNKNOWN**.

---

## 1. `AgentRegistry` — factory registration and `no agent factory registered`

Files: `dsh-agent/lib/index.js`, `dsh-agent/lib/types/index.d.ts`.

### How `setFactory` registers, and what unsets it

- `NO_FACTORY_MESSAGE = "no agent factory registered (load an agent-loop plugin)"`
  — `dsh-agent/lib/index.js:423`.
- `AgentRegistry` class — `dsh-agent/lib/index.js:438`; fields `store = new Map()` (`:441`)
  and `factory` (`:442`) are **per-instance, process-local** state.
- `setFactory(factory)` — `dsh-agent/lib/index.js:558-567`:
  - It is a **`this.ctx.effect(...)`** (`:559`, label `"agents.setFactory()"`, `:566`).
    The setup throws `"an agent factory is already registered"` if `this.factory !== undefined`
    (`:560`). It canonicalizes a traced Cordis service to its concrete target via
    `factory[symbols.original] ?? factory` (`:561`) and stores `this.factory = { target }`
    (`:562`).
  - It returns the effect disposer (`:566`), whose teardown is **the only code that clears the
    slot**: `this.factory = void 0` (`:563-565`). There is no other assignment to
    `this.factory` anywhere in the file (`:442`, `:562`, `:564`, `:570`, `:584`, `:597`).
  - Public signature: `setFactory(factory: AgentFactory): () => void`
    — `dsh-agent/lib/types/index.d.ts:280`.
  - Docs explicitly say "effect-scoped" and "on dispose the factory slot is cleared"
    — `dsh-agent/lib/types/index.d.ts:269-279`.
- `requireFactory()` — `dsh-agent/lib/index.js:569-572`: throws `NO_FACTORY_MESSAGE`
  whenever `this.factory === void 0` (`:570`). It is called by **both** `create()` (`:584`)
  and `resume()` (`:597`).
- `create(options)` — `dsh-agent/lib/index.js:582-587`: `ownerCtx = this.ctx`,
  `const { target } = this.requireFactory()`, `receiver = getTraceable(ownerCtx, target)`,
  then `Reflect.apply(target.createAgent, receiver, [ownerCtx, options])`.
- `resume(options)` — `dsh-agent/lib/index.js:595-600`: same `requireFactory()`, then
  `Reflect.apply(target.resume, receiver, [ownerCtx, options])`.

### Is the factory fiber/scope-owned?

**Yes.** `setFactory` uses `this.ctx.effect(...)` (`:559`). `this.ctx` inside the method is
the **caller-traced** service context, not the registry's own construction context:

- Calling `ctx.agents.setFactory(...)` goes through `ReflectService.handler.get`
  (`cordis/lib/index.js:1253-1256`, `:1269`), which returns `getTraceable(ctx, impl.value)`
  (`cordis/lib/index.js:85-91`, `createTraceable` at `:125-163`).
- For a method access, `createShadowMethod` replaces `this` with a shadow whose `.ctx` is
  `useSite.extend({[symbols.shadow]: defSite})` — `cordis/lib/index.js:112-124`, `:139-146`;
  `useSite` is the caller's context (`:126-127`).
- Therefore `this.ctx` in `setFactory` inherits the **fiber of whoever called
  `ctx.agents.setFactory(...)`** — in production that is the `dsh-agent-loop` plugin fiber
  (`dsh-agent-loop/lib/index.js:1344`). Effects are owned by `ctx.fiber`
  (`Context.register` uses `this.ctx.fiber.effect`, `cordis/lib/index.js:921`;
  `Fiber.effect` at `cordis/lib/index.js:463-573`), and a fiber's effects are all disposed
  when the fiber unloads (`Fiber._unload` → `Promise.all(this._disposables.clear()...)`,
  `cordis/lib/index.js:688-706`) or when its epoch changes (`Fiber._setEpoch` /
  `_refresh` / `_checkImpl`, `cordis/lib/index.js:600-637`).

Consequence: **any disposal/reload of the owning fiber clears `this.factory`**. Sources:

- Plugin fibers are registered as effects on their parent fiber (`cordis/lib/index.js:369-385`,
  `"ctx.plugin()"`), so disposing the root fiber disposes every plugin fiber concurrently
  (`:688-706`).
- A plugin with `inject` deps is torn down/reloaded when an injected service implementation
  changes (`cordis/lib/index.js:347-354`, `:600-610`, `:611-622`, `:623-637`, `:668-683`).
- `setFactory`'s disposer is itself re-collected as a disposable of the loop's
  `agentLoop.setFactory()` effect (`dsh-agent-loop/lib/index.js:1344`; the collected return
  value of an effect is its teardown — `cordis/lib/index.js:429-438`, `:487-490`), so loop
  fiber disposal reliably clears the slot.

### Under what circumstances can `requireFactory()` throw even though `agents.create()`
succeeded earlier in the same process?

Confirmed mechanisms from source (all reduce to `this.factory === void 0`, `:570`):

1. **The owning fiber was disposed between the two calls.** The disposer at
   `dsh-agent/lib/index.js:563-565` runs on fiber unload; `create()` (`:582-587`) succeeded
   while the fiber was alive. This includes whole-app teardown (headless `io.exit`, see §5)
   and config-driven plugin reload (`cordis/lib/index.js:623-637`). In a headless host the
   `headless-runner`'s one-shot task calls `io.exit(...)` (`dsh-headless/lib/index.js:383`)
   as soon as *its own* task ends; the resulting root-fiber disposal clears the factory while
   a long-lived probe plugin's pending work may still be executing — which is consistent with
   the observed "turn 1 OK, turn 2 `no agent factory registered`" (the earlier probe recorded
   `l4-msg-2 ... no agent factory registered` in `/tmp/dsh-l4-home-bmnXVq/probe-result.json`;
   note that file is outside `$CORE` and is only cited as corroboration).
2. **`setFactory` never ran in that host/process.** `AgentLoop.[Service.init]()` awaits two
   `ctx.sessionProjections.register(...)` calls *before* calling `setFactory`
   (`dsh-agent-loop/lib/index.js:1342-1344`). If the `dsh-agent-loop` row is absent, disabled,
   or its fiber is INACTIVE because any of its six injections is missing
   (`dsh-agent-loop/lib/index.js:1299-1306`), `[Service.init]` never runs and the factory is
   never set. `ctx.get(name, strict=true)` returns `undefined` for an impl whose providing
   fiber is not active (`cordis/lib/index.js:1347-1356`), so `ctx.get('agentLoop')` would be
   `undefined` in that case.
3. **A different `AgentRegistry` instance.** `factory` is instance state
   (`dsh-agent/lib/index.js:442`). Service replacement/reload (e.g. the `agent` row's
   `inject: ["sessionProjections"]`, `dsh-agent/lib/index.js:439`, or an `isolate()` scope)
   yields a fresh registry whose `factory` is `undefined` even though an earlier instance
   serviced `create()`. Service resolution is isolate-scoped
   (`Service[symbols.filter]`, `cordis/lib/index.js:1857-1859`).
4. **A startup race.** `ctx.get(...)` strictness only checks `fiber.state === 2`
   (`cordis/lib/index.js:1354`), which is reached after `[Service.init]` settles
   (`_reload` awaits `_execute`, `:668-683`; `_execute` awaits the class plugin's
   `[Service.init]` return, `:361-364`, `:436-439`). A caller that does **not** inject
   `agentLoop` can still race the two `await sessionProjections.register(...)` calls at
   `dsh-agent-loop/lib/index.js:1342-1343` and call `resume()` before line `:1344`.

**UNKNOWN:** which of these actually fired in the earlier probe run cannot be proven from
static source alone (no runtime trace of `agents.factory` transitions was captured in the
materials I was allowed to read). Mechanism (1) is the most consistent with "turn 1 in the
same host succeeded". The probe plugin itself already probes `Boolean(agents.factory)`
(`/tmp/dsh-l4-home-bmnXVq/profiles/feishu-gateway-test/native-session-probe.mjs:84`) — a
snapshot log of that field at each turn would settle it.

### Does `AgentHandle.dispose()` unset the global factory?

**No.** `AgentHandle.dispose()` is defined by the loop, not the registry:
`dispose` at `dsh-agent-loop/lib/index.js:1512-1518` → `teardown()` (`:1475-1509`) aborts the
machine, disposes the agent scope (`:1493`), closes the persistence handle (`:1498`), and
calls `detachAgent?.(); detachSession?.();` (`:1503-1504`), then `unfollowOwner()` /
`unfollowScope?.()` (`:1516`). Nothing in that chain assigns `registry.factory`. The doc
confirms the disposer's scope: "stops the loop, awaits its exit, unregisters the agent, removes
its session from the store, and finally unwinds its scoped world"
(`dsh-agent/lib/types/index.d.ts:131-144`; interface at `:145-148`). Also note the loop's own
`FactoryOwnership.dispose()` (`dsh-agent-loop/lib/index.js:1214-1222`) aborts/awaits live
agents but does not touch `registry.factory`.

---

## 2. `AgentLoop` — setFactory, fiber lifetime, create vs resume, `ResumeAgentOptions`

File: `dsh-agent-loop/lib/index.js`, `dsh-agent/lib/types/index.d.ts`.

### When/how it calls `ctx.agents.setFactory(this)`

- `AgentLoop` class at `:1298`, `static inject = ["agents","sessions","llm","tools",
  "systemPrompt","sessionProjections"]` at `:1299-1306`.
- Constructor `:1328-1337`: `this.ownership = new FactoryOwnership(ctx.fiber)` (`:1335`);
  `this.runtime = { ctx }` (`:1336`). `FactoryOwnership.isActive()` checks
  `this.accepting && !INACTIVE_STATES.has(this.fiber.state)` (`:1188-1190`), i.e. the loop's
  fiber lifetime is the factory's lifetime.
- `[Service.init]()` `:1338-1379`:
  - `:1341` `ctx.effect(() => () => ownership.dispose(), "agentLoop.transactions()")` — on
    fiber teardown, aborts and awaits every live agent (`:1214-1222`).
  - `:1342-1343` **awaits** `ctx.sessionProjections.register(modelSelectionProjectionDefinition)`
    and `register(inboxProjectionDefinition)`.
  - `:1344` `ctx.effect(() => ctx.agents.setFactory(this), "agentLoop.setFactory()")` — the
    **only** production `setFactory` call. Unconditional, but *after* the two awaits above.
  - `:1345-1346` registers `systemPrompt` variables; `:1347-1378` iterates
    `this.config.agents`.
- Service key is `"agentLoop"` (`super(ctx, "agentLoop")`, `:1329`).

### Fiber lifetime

The service is a class plugin (`AgentLoop`), so its fiber is created by the loader row and
activated by Cordis (`cordis/lib/index.js:336-395`; class construction + `[Service.init]` at
`:361-364`). Its fiber is a child effect of the parent fiber (`:369-385`), disposed when the
parent/root fiber is disposed (`:688-706`) or when any injected service changes
(`:600-637`). `FactoryOwnership` ties liveness to exactly that fiber (`:1335`, `:1188-1190`).
Therefore **headless app teardown disposes the loop fiber and, with it, the factory
registration** (§5).

### Does `create` / `resume` differ? Yes

| path | line | session acquisition | `initializeAgent` source |
|---|---|---|---|
| `create(id, options, meta)` (config/startup-driven) | `:1609-1630` | `sessions.prepare(id,{meta})` + `createStoredSession()` → `persistence.create(...)` (`:1616-1617`, `:1640-1650`) | `initializeAgent(this.ctx, {... source: "startup"})` — owner is the **loop's own ctx** (`:1618-1623`) |
| `createAgent(ownerCtx, options)` (public `AgentFactory`) | `:1668-1703` | `sessions.prepare(options.sessionId,{seed,meta,inheritedEventCount})` + `createStoredSession()` (`:1669-1684`) | `initializeAgent(ownerCtx, {... source: "startup", setup, signal, parentAgent})` (`:1685-1693`) |
| `resume(ownerCtx, options)` (public `AgentFactory`) | `:1710-1714` | requires `this.runtime.ctx.get("sessionPersistence")`; else throws `"cannot resume: session persistence is not configured (load a dsh-session-persistence backend)"` (`:1711-1712`); delegates to `resumeWith` (`:1713`) | via `resumeWith` → `initializeAgent(..., source: "resume")` (`:1765`) |
| `resumeWith(ownerCtx, persistence, options)` | `:1716-1775` | `persistence.open(id,"write",{signal:fused})` (`:1733`), `handle.read(0,undefined,{signal})` (`:1736`), `closers = interruptedTurnClosers(persisted)` (`:1739`) appended (`:1740`), `sessions.prepare(id,{seed:[...persisted,...closers], meta: structuredClone(handle.header), inheritedEventCount: handle.inheritedEventCount, eventState: coldRead.eventState})` (`:1741-1746`), `appendUnstoredSuffix` (`:1751`) | `initializeAgent(ownerCtx, {... source: "resume"})` (`:1759-1767`) |

Both converge on `initializeAgent` (`:1455-1598`): it enters/announces the Session
(`agent.ctx.sessions.enter(session)` / `.announce(session)`, `:1571-1572`), awaits `setup`
(`:1574`), then `loopCtx.agents.enter(agent, parentAgent)` / `.announce(agent, source, ...)`
(`:1578-1579`). The real differences are **(a)** fresh `prepare` + `persistence.create`
vs `persistence.open("write")` + cold read + `interruptedTurnClosers` repair, **(b)**
`source: "startup"` vs `"resume"`, **(c)** `resume` additionally requires
`ctx.sessionPersistence` and `ownerCtx.fiber.assertActive()` (`:1755`). `interruptedTurnClosers`
is defined at `dsh-session/lib/index.js:907`.

### `ResumeAgentOptions` requirements

`dsh-agent/lib/types/index.d.ts:111-130`:

- **Only required field**: `resumeSessionId: SessionId` (`:113`).
- Optional: `parentAgent?: Agent` (`:115`), `agentOptions?: AgentOptions` (`:117`),
  `signal?: AbortSignal` (`:119`), `setup?: AgentSetup` (`:129`).
- No `cwd`, `meta`, `seed`, or `inheritedEventCount` (contrast `CreateAgentOptions`,
  `:49-106`): those come from the persisted header/log inside `resumeWith`
  (`dsh-agent-loop/lib/index.js:1741-1746`).
- Docs: "must be called after `ctx.sessionPersistence` exists (consumers inject
  `sessionPersistence`)" — `dsh-agent/lib/types/index.d.ts:181-182`; enforced at
  `dsh-agent-loop/lib/index.js:1711-1712`.
- `AgentFactory` signatures: `createAgent(ownerCtx: Context, options: CreateAgentOptions):
  Promise<AgentHandle>` and `resume(ownerCtx: Context, options: ResumeAgentOptions):
  Promise<AgentHandle>` — `dsh-agent/lib/types/index.d.ts:177`, `:189`.

### `agents: []` implications

`static Config = z.object({ maxParallelToolCalls: ...default(10), agents:
z.array(z.object({ id, sessionId, provider, model, reasoningEffort, maxTokens, cwd,
resumeSessionId })).default([]) })` — `dsh-agent-loop/lib/index.js:1308-1320` (`:1319` is the
`default([])`). In the composed headless profile the row is literally
`{ agents: [] }` (`.tmp/regression/FINAL-dump-config.log:371-374`).

- `agents: []` means **no declarative agents are auto-created**: the loop at `:1347-1378`
  iterates zero entries. It does **NOT** disable the factory — `:1344` is unconditional.
- If a configured entry has `resumeSessionId`, it uses the deferred path
  `ctx.effect(() => ctx.inject(["sessionPersistence"], childCtx =>
  this.resumeWith(ctx, childCtx.sessionPersistence, {...})).dispose, ...)`
  (`:1365-1377`) — i.e. declarative cold resume that *waits* for persistence.
- If a configured entry has `sessionId` and persistence is mounted,
  `restoreOrCreateConfigured` first tries `resumeWith` and only falls back to `create` on
  `SessionPersistenceNotFoundError` (`:1409-1427`).
- Without persistence, `sessionId`/`resumeSessionId` rows are effectively unusable
  (`:1351-1352` create-only branch; `:1366` `ctx.inject(["sessionPersistence"], ...)`).

---

## 3. `dsh-session` — `cannot append outside a SessionStore`

File: `dsh-session/lib/index.js`, `dsh-session/lib/types/index.d.ts`.

### Exact cause

- Module-private `attachments = new WeakMap()` — `dsh-session/lib/index.js:1242`.
- `Session.append(type, data, ...opts)` calls `this.publicationEntry()` first (`:1524-1525`)
  and again before commit (`:1535`); the frozen event is built at `:1536-1542` and
  `commit()` publishes it (`:1544`, `:1589-1608`).
- `publicationEntry()` — `:1576-1582`:
  ```js
  const entry = attachments.get(this);
  if (entry === null) throw new Error(`session "${this.id}" cannot append outside a SessionStore`); // :1578
  if (entry !== void 0 && entry.announcement !== "complete") throw ... // :1579
  if (entry?.appending) throw ... // :1580
  ```
  So the exact cause is **`attachments.get(session) === null`** — the Session object is
  detached (or was never entered). A *truly independent* Session (`undefined`) may append
  without a store (`:1577`, `:1594`, `:1601`); `null` means "was store-owned, now detached".
- Duplicate/source copy of the same check: `dsh-session/lib/types/index.js:705-713`.

### What sets `null` / removes a Session from the store

- `prepare()` sets `attachments.set(session, null)` for both the restore path (`:1821`) and
  the normal `Session.create` path (`:1843`) — a **prepared but not yet entered** Session is
  detached (docs `:1803`: "not yet entered and read-only until announced").
- `enter(session)` — `:1869-1899` — installs the entry: `this.store.set(id, entry)` (`:1886`)
  and `attachments.set(session, entry)` (`:1887`), returning a `detach` closure (`:1889-1898`).
- `detachEntered(entry)` — `:1901-1908` — is the **only removal path**:
  `this.store.delete(entry.id)` (`:1905`), `attachments.set(entry.session, null)` (`:1906`),
  and `emitDisposed(entry)` (`:1907`, event `session/disposed` at `:1944-1956`). It is reached
  via `entry.detach()` (`:1882-1884`) or the `detach` closure (`:1896`). `session/disposed`
  docs: `dsh-session/lib/types/index.d.ts:45-52`.
- `SessionStore.create()` — `:1781-1788` — wraps `prepare`+`enter`+`announce` in one
  `ctx.effect` owned by the calling fiber, so fiber unload detaches the Session.
- `liveEntryFor(session)` — `:1988-1993` — also rejects `entry == null` with
  `"session ... is not live in this store"` (`:1991`).
- `flush(session)` — `:1970-1987` — does NOT detach; it dispatches `session/flush`.

### Does a completed `turn/end` detach it? **No**

`turn/end` is an ordinary appended event: `this.session.append("turn/end", {turn, reason:
turnEnds})` — `dsh-agent-loop/lib/index.js:819-822` (appended in a `finally`, `:817-826`).
Nothing in `dsh-session/lib/index.js` ties `turn/end` to `detachEntered` (the only detach
entry points are `:1882-1884`, `:1896`, `:1901-1908`). `turn/end` docs explicitly say the
loop does not await a flush at turn boundaries (`dsh-session/lib/types/types.d.ts:271-282`).

### Does `AgentHandle.dispose()` remove it? **Yes**

`initializeAgent` stores `detachSession = agent.ctx.sessions.enter(session)` —
`dsh-agent-loop/lib/index.js:1571` — and `teardown()` calls `detachAgent?.();
detachSession?.();` — `:1503-1504`. That is exactly the `enter()` detach closure →
`detachEntered` → `store.delete` + `attachments.set(session, null)` (`:1901-1906`). Confirming
docs: `dsh-agent/lib/types/index.d.ts:131-138` ("removes its session from the store").

**Practical consequence for the probe:** after `handle.dispose()` (or after the whole app
teardown that detaches it), the *same `agent.session` object* is a detached Session with
`attachments.get(...) === null`; reusing the cached handle and appending a new user message
to it throws `cannot append outside a SessionStore`. To continue a detached id you must
re-enter a **new** Session built from persistence (`agents.resume({resumeSessionId})`),
which calls `sessions.prepare(...)` + `enter` + `announce` again
(`dsh-agent-loop/lib/index.js:1741-1746`, `:1571-1572`). Note `resumeWith` also requires the
id not to be live (`dsh-headless/lib/index.js:249-253` guards this for the CLI).

---

## 4. `dsh-session-persistence-jsonl` — files/dirs and cross-process resume requirements

Files: `dsh-session-persistence-jsonl/lib/index.js`, `dsh-session-persistence/lib/index.js`,
`dsh-session-format/lib/index.js`, `dsh-base/cordis.patch.yml`.

### Service + config

- Plugin `name = "session-persistence-jsonl"` (`:3619`), `Config = z.object({ root:
  z.string().required(), compression, listConcurrency })` (`:3621-3625`),
  `apply()` (`:3634-3648`) mounts an inner plugin (`:3639-3644`) constructing
  `JsonlSessionPersistence` (class `:2403`), which extends `SessionPersistence` and provides
  the service key **`sessionPersistence`**
  (`dsh-session-persistence/lib/index.js:261-266`, `super(ctx, "sessionPersistence")` at
  `:265`).
- Default in `dsh-base` / headless composition: `root: !!js dshHomePath('sessions')`
  (`dsh-base/cordis.patch.yml:138-141`; confirmed in the composed headless config
  `.tmp/regression/FINAL-dump-config.log:85-88`). Default `compression = "zstd"`
  (`:2290`, `:2435`).

### Directory / file layout (all under the configured `root`)

- `projectDir(root, cwd)` = `join(root, projectKey(cwd))`, or `join(root, "_no-cwd")` when
  `cwd` is absent — `:901-910`; `projectKey` produces `--<readable>--` with `/`,`\`,`:`
  → `-` and `~XXXX` escapes, truncated to 251 chars (`:872-899`).
- `sessionDir(root, cwd, id)` = `join(projectDir, encodeSegment(id))` — `:911-921`;
  `encodeSegment` escapes `.`/`..`/separators/NUL as `~XXXX` (`:847-870`).
- `generationLogPath` = `join(sessionDir, generationLogFilename(version, compression))` —
  `:922-933`; `logPath` uses `SESSION_FORMAT_VERSION` (`:934-944`).
- `generationLogFilename(version, compression)` = `sessionFormatLogFilename(version) +
  compressionSuffix` — `:766-768`; `sessionFormatLogFilename(v)` returns `session.jsonl` for
  v0 and `session.vN.jsonl` for v>0 (`dsh-session-format/lib/index.js:472-475`);
  `compressionSuffix` = `.zstd` or `""` (`:755-757`), so suffix is `.jsonl.zstd` or
  `.jsonl` (`:747-754`). Current `SESSION_FORMAT_VERSION = 4`
  (`dsh-session/lib/index.js:56`) → **`session.v4.jsonl.zstd`** by default.
- `LEASE_FILENAME = "session.lock"` — `:648`; acquired inside the session dir for write
  (`:665-673`, called at `:2525`).
- Other files: `.<random>.tmp` staging files (`:3265-3275`), `local/dsh-session-lock-<sha256>`
  named kernel lock on win32 (`:563`).
- Physical content: one JSONL **header line first** (`toHeaderLine`, `:807-818`;
  `HEADER_REQUIRED_KEYS` at `:782-789`), then one JSON line per event (`eventLines`,
  `:946-952`), optionally zstd-framed (`encodeMaterialization`, `:3276-3285`). A created
  session stays in-memory (`tracker.pending`) until the first append/flush materializes it
  (`:2400-2401`, `:2465-2479`, `:3202-3244`); docs at
  `dsh-session-persistence/lib/index.js:251-256`.

### What must be present for `agents.resume({resumeSessionId})` in a NEW process/host

1. **The `sessionPersistence` service must be mounted and active.** `AgentLoop.resume()`
   reads `this.runtime.ctx.get("sessionPersistence")` and throws
   `"cannot resume: session persistence is not configured (load a dsh-session-persistence
   backend)"` if absent — `dsh-agent-loop/lib/index.js:1711-1712`. It must be configured with
   the **same `root`** (same `DSH_HOME`) as the writer.
2. **The physical artifact must exist and be findable.** `open(id, "write", ...)` calls
   `findLog(id)` and throws `SessionPersistenceNotFoundError(id)` when
   `findLog` returns `void 0` — `:2488-2524`; `findLog` scans every project dir, looks for
   `join(project, encodeSegment(id))` and the highest supported generation — `:3451-3465`,
   `:3419-3450` (`resolveGenerationInDirectory`). `requireStoredLog` (`:2652-2681`,
   `:2834`) then reads/repairs it.
3. **Valid header first line** (`:807-846`, `:843-845` `isHeaderLine`), format version ≤ 4
   (`storedVersion` gate at `:963-971`, `:1674-1677`; refusal text
   `dsh-session-persistence/lib/index.js:137-139`, `:165-167`), header `cwd` absolute and
   `id` matching the requested id (`assertStoredIdentity`, `:3475-3487`), and the file must
   live at exactly `generationLogPath(root, meta.cwd, meta.id, version, compression)`
   (`:3481-3485`).
4. **Valid, contiguous, known event rows.** `validateStoredEvents` refuses any event type not
   in `KNOWN_SESSION_EVENT_TYPES` unless `ignorable: true`
   (`dsh-session-persistence/lib/index.js:182-197`; vocabulary list at
   `dsh-session/lib/types/known-event-types.js:21-84`); `assertContiguous`
   (`dsh-session-persistence/lib/index.js:229-231`). Torn tails are truncated/repaired
   (`:1127-1134`, `:222-233`).
5. **The write lease must be free** — `acquireLease` (`:665-673`, `:2525`, `:2975`), plus
   in-process single-writer claim (`:2520`). A still-open writer in another process blocks
   this.
6. **`agents.resume` must be called through the registry, which needs a registered factory**
   (`dsh-agent/lib/index.js:595-600`) — see §1/§7.

### Is `session-projection` / `session-query-sqlite` / `storages/` required?

- **Not for `agents.resume()` itself.** The only persistence dependency is
  `ctx.sessionPersistence` (`dsh-agent-loop/lib/index.js:1711`). `sessionProjections` is a
  general prerequisite of `dsh-agent` (`dsh-agent/lib/index.js:439`) and `dsh-agent-loop`
  (`:1305`) — both register projections in `[Service.init]` — but that is a base-tree
  requirement, not resume-specific.
- **`ctx.sessionQuery` is required only by the `dsh-headless --session-id` adopt path**:
  `resolveAgent` throws `"headless --session-id requires the sessionPersistence service"` and
  `"headless --session-id requires the sessionQuery service"` —
  `dsh-headless/lib/index.js:246-248` — then calls `query.observeSession(sessionId)`
  (`:261-262`) before `agents.resume(...)` (`:263-267`). A test-only plugin that calls
  `agents.resume()` **directly** does not need `sessionQuery`. Service key `sessionQuery` is
  provided by `dsh-session-query/lib/index.js:1048`, with the SQLite owner in
  `dsh-session-query-sqlite/lib/index.js:475-531`. Default config is `path: ':memory:'`,
  `openAt: never` (`dsh-base/cordis.patch.yml:157-161`,
  `.tmp/regression/FINAL-dump-config.log:91-95`), i.e. **no durable SQLite index is needed**
  and search stays disabled.
- **`storages/` is a different thing**: `storage-json` uses `root: !!js
  dshHomePath('storages')` (`dsh-base/cordis.patch.yml:179-185`,
  `.tmp/regression/FINAL-dump-config.log:104-107`), which backs the KV `storage` hub and the
  `session-projection-cache` (`dsh-base/cordis.patch.yml:192-199`). It is a web-side listing
  cache, **not** the session log; the session log lives under `sessions/`. Neither
  `session-projection-cache` nor `storages/` is a prerequisite for `agents.resume()`.
- `session-projection` row (`dsh-base/cordis.patch.yml:172-173`) provides
  `ctx.sessionProjections` (`dsh-session-projection/lib/index.js:66`) — a host-side fold
  registry; it is part of the base tree, not a cold-resume artifact.

---

## 5. `dsh-headless` — agent ownership and host lifetime

Files: `dsh-headless/lib/index.js`, `dsh-cmdline/lib/index.js`,
`dsh/lib/profile-boot-e2mS45fC.js`, `cordis/lib/index.js`.

### How headless registers/owns agents

- Plugin `name = "headless-runner"` (`:100`), `inject = ["agentDefaultModel","agents",
  "sessions"]` (`:102-106`), `Config` (`:107-113`).
- `apply(ctx, config)` (`:395-406`) gets `ctx.get("appExit")` (`:396-397`) and starts
  `run(ctx, config, io)` **fire-and-forget** with `.catch(fail)` (`:403-405`). It does not
  await the task.
- `run()` (`:298-389`): `await ctx.get("loader")?.await()` (`:299`); resolves
  `agents`/`sessions`/`agentDefaultModel` (`:300-303`); builds `agentOptions` from
  `defaultModel.currentSelection()` (`:322-323`); `setup` installs model selection
  (`:324-332`); then **creates or adopts**:
  - no `--session-id`: `(await agents.create({ sessionId, meta:{cwd}, agentOptions, setup
    })).agent` (`:336-340`);
  - with `--session-id`: `resolveAgent(...)` → `agents.resume({ resumeSessionId: sessionId,
    agentOptions, setup })` (`:245-280`, specifically `:263-267`), which additionally requires
  `sessionPersistence` and `sessionQuery` (`:246-248`) and refuses a live id (`:249-253`).
- Driving: `await agent.whenIdle()` (`:342`, `:370`),
  `agent.followup(createUserMessage(...))` (`:361-367`), subagent wait loop (`:368-373`),
  `await sessions.flush(agent.session)` (`:377`), `summarize` (`:379`), then
  **`io.exit(...)`** (`:383`).
- Error/terminal listening for the run: `agent/error` (`:350-355`) and `session/event`
  `turn/end` (`:356-358`).

### Does headless task completion dispose the factory / store entries? **Yes**

- `io.exit` is the launcher's `appExit`: `provideCmdline(ctx, host)` does
  `ctx.provide("appExit", host.exit)` — `dsh-cmdline/lib/index.js:27-32` (`:30`).
- The launcher wires `exit: (code) => void shutdown.shutdown(code)` —
  `dsh/lib/profile-boot-e2mS45fC.js:308-312` (`:310`).
- `shutdown.shutdown(code)` → `start(code,false)` → `Promise.resolve().then(dispose)` —
  `dsh/lib/profile-boot-e2mS45fC.js:47-59`; `dispose` calls
  `app.current?.fiber.dispose()` (`:262-271`, specifically `:264`).
- Root-fiber disposal cascades to **all** child plugin fibers, which are effects on the parent
  (`cordis/lib/index.js:369-385`, disposal `:688-706`). Effects are disposed with
  `Promise.all` across the fiber (`:696`), i.e. **concurrently**, and each effect's own
  collected disposables run in reverse order (`cordis/lib/index.js:469-478`).
- Therefore, on headless task completion:
  - `agentLoop.setFactory()` effect (`:1344`) → `agents.setFactory()` disposer →
    `this.factory = void 0` (`dsh-agent/lib/index.js:563-565`);
  - `agentLoop.transactions()` effect (`:1341`) → `FactoryOwnership.dispose()`
    (`:1214-1222`) aborts/awaits every live agent;
  - `sessions.create()` / `agentLoop.lifecycle(...)`, `agentLoop.scope(...)` effects
    (`dsh-session/lib/index.js:1783-1786`, `dsh-agent-loop/lib/index.js:1531-1546`,
    `:1534-1537`) teardown → `detachSession()` → `detachEntered()` →
    `store.delete` + `attachments.set(session, null)` + `session/disposed`
    (`dsh-session/lib/index.js:1901-1907`).
- There is also a **hard 5 s ceiling**: `PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3`
  (`dsh/lib/profile-boot-e2mS45fC.js:13`), armed before disposal (`:49-51`), after which
  `process.exit(code)` is forced (`:22-23`, `:35-40`).

### Would a long-running probe plugin's `ctx.effect` disposer keep the host alive for 3 turns?

**No — not as a liveness guarantee.** A `ctx.effect(execute)` disposer is a *teardown
callback*: it runs **when the fiber unloads** (`cordis/lib/index.js:463-573`, wrapper at
`:533-540`), and the fiber's unload **awaits** it (`Fiber._unload`, `:688-706`). So an async
disposer such as `ctx.effect(() => async () => { await work })` can *delay* teardown while
`work` is pending, but:

- it cannot prevent the headless-runner from calling `io.exit(...)` at
  `dsh-headless/lib/index.js:383` once its own one-shot task completes;
- the 5 s forced-exit timer (`dsh/lib/profile-boot-e2mS45fC.js:13`, `:49-51`) bounds how
  long any disposer can hold the process;
- during that teardown window, sibling fibers (including `agent-loop`) are being disposed
  **concurrently** (`cordis/lib/index.js:696`), so `agents.factory` can already be cleared
  while `work` continues — a direct explanation for "turn 1 OK, turn 2 `no agent factory
  registered`" in this exact headless setup.

For **3 turns in ONE continuously running host** the practical options are:
(a) do not mount / disable the `headless-runner` row for the probe (so nothing calls
`appExit`), let the probe plugin own the long-lived driver and keep an interval/listener
alive; or (b) drive all 3 messages inside a single headless task before `run()` reaches
`io.exit` (`dsh-headless/lib/index.js:359-383`) — e.g. multiple `agent.followup()` calls
before `whenIdle()`/`flush`. **UNKNOWN:** which of these the current test harness will choose.

---

## 6. Exact event payload shapes

### `session/event` — `assistant/message`

- Declaration: `'session/event'(this: Scoped<Session>, session: Session, event:
  SessionEvent): void` — `dsh-session/lib/types/index.d.ts:53-63`. Post-commit,
  fire-and-forget, scope-filtered (`:54-61`).
- Event envelope (built in `Session.append`, `dsh-session/lib/index.js:1524-1546`):
  `{ type, seq: SessionSeq, time: number (epoch ms), data: <snapshotted>, surfaceOp?,
  sourceEventSeqs?, ignorable? }`; `SessionEvent` type at
  `dsh-session/lib/types/types.d.ts:497-520`.
- `assistant/message` `data` — `dsh-session/lib/types/types.d.ts:328-346`:
  `{ turn: number, step: number, message: AssistantMessage, stream:
  AssistantStreamRecord[], usage?: TokenUsage, interrupted?: true }`, plus
  `surfaceOp: "append"` (surface event, `dsh-session/lib/types/types.d.ts:450`,
  `:475-483`; append call at `dsh-agent-loop/lib/index.js:949-955`).
- `message` = `createAssistantMessage({content, source:{provider, model, replayState?}})`
  (`dsh-agent-loop/lib/index.js:941-948`; `dsh-llm/lib/index.js:70-79`):
  `{ role: "assistant", content: ContentBlock[], source: {kind: "model", provider, model,
  ...} , id }`. Text blocks are `{ type: "text", text: string }`
  (`dsh-llm/lib/types/types.d.ts:52-56`); reasoning blocks `{type:"reasoning",text}`
  (`:57-61`). Extract text with
  `event.data.message.content.filter(b => b.type === "text").map(b => b.text).join("")`
  (exact pattern used by headless `summarize`, `dsh-headless/lib/index.js:129-132`).
- `interrupted: true` marks a mid-stream cancellation prefix
  (`dsh-session/lib/types/types.d.ts:333-336`, `:345`; appended at
  `dsh-agent-loop/lib/index.js:891-905`).

### `agent/assistant-stream` — text deltas

- Declaration: `'agent/assistant-stream'(this: Scoped<Agent>, payload: { agent: Agent,
  frame: AssistantStreamFrame }): void` —
  `dsh-agent/lib/types/runtime-types.d.ts:393-404`. `agent` is injected by the fused
  dispatcher (`agentEvents` in `dsh-agent/lib/index.js:358-388`); emitted by the loop at
  `dsh-agent-loop/lib/index.js:872-874` (`this.dispatch.emit("agent/assistant-stream",
  { frame })`).
- `AssistantStreamFrame` is a 3-way union —
  `dsh-agent/lib/types/runtime-types.d.ts:132-162`:
  - `{ type: "start", attemptId, revision, turn, step }` (`:133-139`);
  - `{ type: "chunk", attemptId, revision, index, time, chunk: StreamChunk }`
    (`:140-148`) — **this is where text deltas live**;
  - `{ type: "end", attemptId, revision, index, outcome:
    {kind:"committed", eventType:"assistant/message"|"assistant/attempt", seq} |
    {kind:"abandoned"} }` (`:149-162`).
- `StreamChunk` — `dsh-llm/lib/types/types.d.ts:450-488`:
  - `{type:"text-delta", index, text: string}` (`:463-466`) ← **visible text delta**,
  - `{type:"reasoning-delta", index, text}` (`:467-470`),
  - `{type:"block-start", index, blockType}` (`:459-462`),
  - `{type:"tool-call-delta", index, id, name?, argumentsDelta}` (`:471-475`),
  - `{type:"block-end", index, block}` (`:476-479`),
  - `{type:"usage", usage}` (`:481-482`), `{type:"finish", reason, replayState?}` (`:484-487`).
- Headless's own consumer (`streamReasoning`, `dsh-headless/lib/index.js:148-198`) shows the
  exact access pattern: `payload.frame.type` (`"start"`/`"end"`/else chunk), then
  `frame.chunk.type` and `frame.chunk.text` (`:157-192`); it treats `text-delta` as closing
  a reasoning line (`:185-189`).
- Important: chunk frames are **transient**; the durable record is one final
  `assistant/message` (or `assistant/attempt`) carrying the compact `stream` array
  (`dsh-agent/lib/types/runtime-types.d.ts:393-395`; `dsh-agent-loop/lib/index.js:921-955`).
  Do not reconstruct the reply by concatenating deltas *and* the final message (double count).

### `session/event` types that signal errors / timeouts / cancellation

**There is no dedicated `session/event` type named `error`, `timeout`, or `cancel`.**
`KNOWN_SESSION_EVENT_TYPES` (`dsh-session/lib/types/known-event-types.js:21-84`) contains
none of them; plugins can add `plugin:` records (`dsh-session/lib/types/types.d.ts:522-535`)
or merge new `TurnEndReasonMap` variants (`:168-216`, "merge-extensible", `:170`).

The actual signals are:

| signal | where | shape |
|---|---|---|
| `turn/end` with `reason.kind === "error"` | `dsh-session/lib/types/types.d.ts:271-282`, `:182-191`; set at `dsh-agent-loop/lib/index.js:809-815` | `{turn, reason: {kind:"error", error: {code, message}}}` (`code` = `TOOL_ACTIVATION_FAILED` / `UNKNOWN`, `:813`) |
| `turn/end` with `reason.kind === "aborted"` (cancellation) | `dsh-session/lib/types/types.d.ts:174-178`; set at `dsh-agent-loop/lib/index.js:800-807` | `{turn, reason: {kind:"aborted", reason: TurnEndCancelCause}}`; `AgentCancelCause` kinds `user`/`parent`/`hook{reason}`/`disposed` (`dsh-session/lib/types/types.d.ts:152-162`), plus `legacy` (`:163-166`) |
| `turn/end` with `reason.kind === "interrupted"` (crash-orphaned turn closed after the fact on resume) | `dsh-session/lib/types/types.d.ts:196-204`; `interruptedTurnClosers` (`dsh-session/lib/index.js:907`), appended at `dsh-agent-loop/lib/index.js:1739-1740` | `{turn, reason:{kind:"interrupted"}}` |
| `turn/end` `blocked` / `max-tokens` / `completed` / `forked` | `dsh-session/lib/types/types.d.ts:170-213` | `{kind:"blocked"}`, `{kind:"max-tokens"}`, `{kind:"completed"}`, `{kind:"forked"}` |
| `assistant/message` with `interrupted: true` | `dsh-session/lib/types/types.d.ts:333-345`; `dsh-agent-loop/lib/index.js:891-905` | cancelled mid-stream, delivered text prefix |
| `assistant/attempt` | `dsh-session/lib/types/types.d.ts:347-356`; `dsh-agent-loop/lib/index.js:906-928` | failed / retried / cancelled / stream-error attempt with no surface message |
| `agent/error` (**agent-scoped emit, not `session/event`**) | `dsh-agent/lib/types/runtime-types.d.ts:427-442`; emitted `dsh-agent-loop/lib/index.js:640-649`; consumed `dsh-headless/lib/index.js:350-355` | `{agent, turn, step, error: unknown}` |
| `agent/status` | `dsh-agent/lib/types/runtime-types.d.ts:108-115`, `:279`; emitted `dsh-agent-loop/lib/index.js:557-563` | `{status: "idle" \| "running"}` |
| `session/disposed` | `dsh-session/lib/types/index.d.ts:45-52`; emitted `dsh-session/lib/index.js:1907`, `:1944-1956` | Session left the store (lifecycle, not a turn outcome) |
| `agent-loop/config-start-failed` | `dsh-agent-loop/lib/index.js:1392-1407` | `{sessionId, error}` for config-driven startup failures |
| `agent/request-error` | `dsh-agent/lib/types/runtime-types.d.ts:383-391`; `dsh-agent-loop/lib/index.js:929-938` | `{agent,turn,step,provider,failure,retryPolicy,signal}` (waterfall) |

**TIMEouts — UNKNOWN.** No `timeout` event type, no `timeout` cancel-cause kind, and no
`timeout` string was found in `dsh-agent-loop/lib/index.js`,
`dsh-session/lib/types/types.d.ts`, `dsh-agent/lib/types/runtime-types.d.ts`, or
`dsh-headless/lib/index.js` (grep returned no matches). Timeouts must therefore surface as a
`turn/end` `aborted`/`error` reason, an `agent/error`, or a plugin-specific extension; which
one any given plugin emits cannot be confirmed from core source. Cancellation is explicit:
`agent.cancel({kind:"user"})` (`dsh-agent-loop/lib/index.js:579-585`;
`workspace/session-stop` uses it at `dsh-agent/lib/index.js:36-39`).

---

## 7. MINIMAL correct way to make `agents.resume()` work from a test-only Cordis plugin

### The three candidate answers, evaluated

1. **Is `ctx.get('agentLoop')` enough? — No.**
   `ctx.get(name, strict = true)` merely *reads* the service and returns `undefined` when
   the providing fiber is not active (`cordis/lib/index.js:1340-1356`). It does not register
   anything. The factory is registered by the loop's own `[Service.init]` through
   `ctx.agents.setFactory(this)` (`dsh-agent-loop/lib/index.js:1344`); if the loop plugin is
   not mounted/active, `ctx.get('agentLoop')` is `undefined` and `requireFactory()` still
   throws (`dsh-agent/lib/index.js:569-572`). If the loop *is* active, calling
   `ctx.agents.setFactory(ctx.get('agentLoop'))` yourself would throw
   `"an agent factory is already registered"` (`dsh-agent/lib/index.js:560`) — so it is both
   unnecessary and harmful.
2. **Must we call `ctx.agents.setFactory(...)` manually? — Not in the normal case; only if
   you deliberately omit the loop plugin.**
   `setFactory` is public (`dsh-agent/lib/types/index.d.ts:280`) but its argument must be a
   full `AgentFactory` (`dsh-agent/lib/types/index.d.ts:155-190`):
   `createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle>`
   (`:177`) and `resume(ownerCtx: Context, options: ResumeAgentOptions):
   Promise<AgentHandle>` (`:189`). Reimplementing that in a test plugin means reimplementing
   session `prepare`/`enter`/`announce`, loop driving, projections and teardown
   (`dsh-agent-loop/lib/index.js:1455-1598`) — not "minimal". Also note registration is
   effect-scoped and single-slot (`:558-567`), so it must be yielded as an exact Cordis
   effect disposer in the plugin's composite teardown order
   (`dsh-agent/lib/types/index.d.ts:269-279`; `dsh-agent/lib/index.js:611-619` for `register`'s
   exact-identity requirement).
3. **Configure / mount the `agent-loop` row — YES, this is the minimal correct path.**
   The real `AgentLoop` service is the factory. Requirements:
   - The `agent-loop` row (`name: '@deepseek-ai/dsh-agent-loop'`) must be **present and
     active**. In the composed headless profile it already is, with `agents: []`
     (`.tmp/regression/FINAL-dump-config.log:371-374`); `agents: []` does **not** suppress
     `setFactory` (`dsh-agent-loop/lib/index.js:1344` unconditional).
   - All six of `AgentLoop`'s injections must be available: `agents`, `sessions`, `llm`,
     `tools`, `systemPrompt`, `sessionProjections` (`dsh-agent-loop/lib/index.js:1299-1306`);
     otherwise the plugin fiber stays INACTIVE (`cordis/lib/index.js:611-622`, `:600-610`)
     and `[Service.init]` (hence `setFactory`) never runs. In addition `dsh-agent` itself
     injects `sessionProjections` (`dsh-agent/lib/index.js:439`).
   - Wait for activation before calling `resume()`. Declaring
     `inject: ['agents','agentLoop','sessions','llm']` on the probe (as the existing probe
     does) makes Cordis activate the probe only once those services are live
     (`cordis/lib/index.js:347-354`, `:392-395`); `ctx.get('loader')?.await()`
     (`dsh-headless/lib/index.js:299`) is the CLI's equivalent barrier. Do **not** fire
     `resume()` from a bare `apply()` with no `inject` — that races lines `:1342-1344`.
   - `ctx.sessionPersistence` must exist (`dsh-agent-loop/lib/index.js:1711-1712`;
     `dsh-agent/lib/types/index.d.ts:181-182`). It is provided by the base
     `session-persistence-jsonl` row with `root: dshHomePath('sessions')`
     (`dsh-base/cordis.patch.yml:138-141`).
   - Call `ctx.agents.resume({ resumeSessionId })` with only the required id
     (`dsh-agent/lib/types/index.d.ts:111-130`, `:300`); do not pass `cwd`/`meta`/`seed`.
   - **Keep the host (and thus the loop fiber) alive** for the whole test: avoid the
     headless-runner's `io.exit` (§5), or complete all turns inside one task. Otherwise the
     factory is cleared mid-test.

### One-line recipe

```
# In the probe profile's composition (patch layer), keep these rows ACTIVE:
- id: agent-loop                 # @deepseek-ai/dsh-agent-loop, config: { agents: [] }
- id: session-persistence-jsonl  # @deepseek-ai/dsh-session-persistence-jsonl, root = same DSH_HOME/sessions
# (both already in dsh-base / the headless composition — do not disable them)
# Probe plugin: inject: ['agents','agentLoop','sessions','llm']  (plus 'llm' route config)
# Probe code:   await ctx.get('loader')?.await();  // or rely on inject activation
#               await ctx.agents.resume({ resumeSessionId });
```

For a **cross-host cold resume**, additionally ensure: the writer's `session.flush` barrier
ran (`dsh-headless/lib/index.js:377`; `dsh-session/lib/index.js:1970-1987`), the JSONL artifact
exists at `<DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/session.v4.jsonl[.zstd]`
with a valid header line (§4), the `session.lock` write lease is free
(`dsh-session-persistence-jsonl/lib/index.js:648`, `:2525`), and the new host uses the **same
`root`** and has `sessionPersistence` mounted. `sessionQuery` / SQLite / `storages/` are not
needed unless you go through `dsh-headless --session-id`
(`dsh-headless/lib/index.js:246-248`).

### Declarative alternative (no plugin code)

If a test wants the loop to cold-resume on its own, set the `agent-loop` row's
`agents: [{ id, resumeSessionId, provider, model, reasoningEffort, maxTokens, cwd, ... }]`;
`[Service.init]` uses `ctx.effect(() => ctx.inject(["sessionPersistence"], childCtx =>
this.resumeWith(ctx, childCtx.sessionPersistence, {...})).dispose, ...)`
(`dsh-agent-loop/lib/index.js:1365-1377`), which waits for persistence and calls the same
`resumeWith` path. Config fields are declared at `dsh-agent-loop/lib/index.js:1310-1319`.

---

## Summary of confirmed root causes for the two observed failures

- **`cannot append outside a SessionStore`** = reusing a cached `agent.session` whose
  `attachments` entry was set to `null` by `detachEntered` (`dsh-session/lib/index.js:1901-1906`,
  `:1578`), which happens on `AgentHandle.dispose()` (`dsh-agent-loop/lib/index.js:1503-1504`)
  or whole-app teardown. `turn/end` does **not** cause it.
- **`no agent factory registered (load an agent-loop plugin)`** = `registry.factory ===
  void 0` (`dsh-agent/lib/index.js:423`, `:569-572`), cleared only by the `setFactory` effect
  disposer (`:563-565`) — i.e. the `agent-loop` plugin fiber was disposed/reloaded (most
  plausibly by headless `io.exit` → root-fiber disposal, §5), or `setFactory` never ran
  because the loop fiber was INACTIVE / absent in that host. `agents: []` is **not** the
  cause (`:1344` is unconditional).

## Explicitly UNKNOWN / not confirmed

- Which exact trigger cleared `agents.factory` in the earlier probe run (no captured factory
  transition trace available in the read-only material); several source-confirmed mechanisms
  are listed in §1, ranked by consistency with the evidence.
- Whether any out-of-core plugin emits a dedicated timeout `session/event` (core has none).
- Whether the current test harness will disable `headless-runner` or batch all turns into one
  headless task to achieve "3 turns in one continuously running host" (§5).
- The exact contents of the isolated temp `DSH_HOME` at the moment of the failing turn
  (I only read its config/results files that were present; I did not boot anything).
