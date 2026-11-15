# Scheduled tasks implementation contract (Issue #19)

> Internal design contract for the `feat/scheduled-tasks` branch. This is the
> **single source of truth** for the cross-profile interfaces between the
> Gateway (TypeScript, `src/`) and the Web Admin (plain JS, `web-admin/`).
> Do not change a field name here without updating both sides.

## 0. Principle

DSH's **native `ctx.schedule` Host service** (`@deepseek-ai/dsh-schedule@0.2.2-rc.1`)
owns task definitions, recurrence, pause/resume/run-now/delete, missed-run handling
and durable delivery history. The Gateway is only a **bridge**:

* Web Admin (profile `web`) -> cross-profile `ops-control` command mailbox -> Gateway
  (profile `feishu-channel`) -> `ctx.schedule` (local native Host service).
* The Gateway publishes a **redacted read model** to `stateDir/ops-schedule.json`
  that the Web Admin reads; no direct RPC from Web to the schedule service.
* A **Feishu-only delivery sidecar** (`stateDir/schedule-delivery.json`) maps a
  native task id -> Feishu chat target. This is explicitly *not* a second scheduler.

The plugin never creates its own cron engine, never starts a second Agent/LLM loop
and never bypasses the user/group allowlist or DSH native tool approval.

Native API evidence (installed package):
`/home/ubuntu/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/types/{index,types}.d.ts`
and `lib/index.js` (`ScheduleService`, `ScheduleRuntime.send()`,
`schedule/resolve-agent` waterfall, `schedule/changed` emit).

## 1. Canonical schedule spec (JSON)

The Web Admin form, the preview endpoint and the operator command all use this
shape. `time` is local `HH:mm:ss` (optional `.SSS`), `weekdays` are ISO 1..7
(Monday..Sunday), `day` is 1..31, `expression` is a 5-field Vixie cron
(`minute hour day-of-month month day-of-week`), `at` is either an absolute
ISO-8601 UTC instant (`...Z`) or a local `YYYY-MM-DDTHH:mm:ss` wall clock.
`timeZone` is always explicit (`UTC` or an IANA Area/Location name).

```ts
type ScheduleSpec =
  | { kind: 'once';    at: string;         timeZone: string }
  | { kind: 'every';   everySeconds: number }
  | { kind: 'daily';   time: string;       timeZone: string }
  | { kind: 'weekly';  time: string;       timeZone: string; weekdays: number[] }
  | { kind: 'monthly'; time: string;       timeZone: string; day: number }
  | { kind: 'cron';    expression: string; timeZone: string }
```

Limits: title `1..120` chars (trimmed, non-empty); prompt `1..4000` chars
(trimmed, non-empty); `everySeconds` integer `>= 60`; preview count `1..10`.

Mapping to native `ScheduleTiming` (exact, from the installed `.d.ts`):

| spec.kind | native `timing` |
| --- | --- |
| `once` | `{ kind:'at', at: { date:'YYYY-MM-DD', time:'HH:mm:ss', time_zone } }` (local) or `{ kind:'at', at: '<ISO UTC>' }` (absolute) |
| `every` | `{ kind:'every', every_seconds }` |
| `daily` | `{ kind:'daily', daily: { time, time_zone } }` |
| `weekly` | `{ kind:'weekly', weekly: { time, time_zone, weekdays } }` |
| `monthly` | `{ kind:'cron', cron: { expression: '<min> <hour> <day> * *', time_zone } }` (months without that day are skipped) |
| `cron` | `{ kind:'cron', cron: { expression, time_zone } }` |

`src/schedule/spec.ts` exports `ScheduleSpec`, `validateSpec`, `toNativeTiming`,
`previewOccurrences(spec, count, fromMs): string[]` (UTC ISO instants),
`nativeRecordToSpec(record): ScheduleSpec | undefined`, `specSummary(spec)`.
`web-admin/src/schedule-spec.mjs` mirrors `validateSpec` + `previewOccurrences`
in plain JS (no DSH imports). Both sides must reject the same inputs.

Preview algorithm (both sides): convert explicit local wall-clock candidates to
UTC with `Intl.DateTimeFormat` offset probing (DST-safe, `timeZone` explicit),
never with a fixed numeric offset. Generate candidates day-by-day over a bounded
horizon (<= 366 days); for `cron`, expand the matching minute/hour sets per day.
Return the first `count` strictly-future instants as UTC ISO strings.

## 2. Cross-profile operator command (`src/ops/commands.ts`)

One new command type `type: 'schedule'` is added to the existing
`ops-control/requests/<uuid>.json` mailbox. The existing commands keep their
1024-byte cap; schedule commands are allowed up to 8192 bytes. The Gateway
**always revalidates** the payload (Web Admin is not a trust boundary).

```json
{
  "version": 1,
  "id": "<uuid>",
  "ts": 1699000000000,
  "type": "schedule",
  "actor": "dsh-web-admin",
  "schedule": {
    "action": "create|update|pause|resume|run|delete|delete-inactive|refresh",
    "clientRef": "<uuid>",
    "taskId": "schedule-<uuid>",
    "title": "每日新闻简报",
    "prompt": "汇总今天的新闻",
    "spec": { "kind": "daily", "time": "09:00:00", "timeZone": "Asia/Shanghai" },
    "notify": "result|failure|both|none",
    "delivery": { "botId": "default", "chatId": "oc_xxx", "chatType": "group", "senderId": "ou_xxx" },
    "expectedUpdatedAt": "2026-11-15T12:00:00.000Z"
  }
}
```

`delivery: null` clears the Feishu delivery config; `spec`/`title`/`prompt` omitted
on `update` keep their stored values. `actor` is a bounded server-derived label
(<= 64 chars). `clientRef` is required for `create` and is used to reserve one
Gateway-owned native Session id before the native task id exists.
`delivery.chatId` accepts `oc_…` (chat_id) or `ou_…` (user open_id); an `ou_`
target is sent with `receive_id_type: 'open_id'`. Group targets must be `oc_…`.

`OperatorResult` gains an optional bounded `detail` string (<= 200 chars, no
secrets / no raw exception bodies). `readOpsResults()` in `web-admin/src/ops-read.mjs`
must whitelist `type: 'schedule'` and expose `detail`.

## 3. Gateway `ScheduleManager` public API (`src/schedule/manager.ts`)

The Lead owns everything OUTSIDE `src/schedule/**`. The schedule-core teammate
owns `src/schedule/**` and must implement exactly this surface:

```ts
export interface ScheduleManagerHooks {
  readonly logger: GatewayLogger
  readonly stateDir: string
  readonly now: () => number
  readonly isStopped: () => boolean
  /** Create/reserve one Gateway-owned native DSH Session for a task. */
  readonly ensureTaskSession: (clientRef: string) => Promise<string>
  /** Retire a task Session after deletion (best effort). */
  readonly releaseTaskSession: (sessionId: string) => Promise<void>
  /** Re-check the current allowlist/group policy for a Feishu target. */
  readonly validateFeishuTarget: (target: FeishuDeliveryInput) =>
    Promise<{ ok: true } | { ok: false; reason: string }>
  /** Durable, idempotent Outbox send. key must be stable per delivery. */
  readonly sendFeishu: (
    botId: string,
    target: { chatId: string; text: string; format?: 'text' | 'markdown' },
    idempotencyKey: string,
  ) => Promise<boolean>
}

export interface FeishuDeliveryInput {
  readonly botId: string
  readonly chatId: string
  readonly chatType: 'p2p' | 'group'
  readonly senderId?: string
}

export interface ScheduleCommand {
  readonly action: 'create'|'update'|'pause'|'resume'|'run'|'delete'|'delete-inactive'|'refresh'
  readonly actor: string
  readonly clientRef?: string
  readonly taskId?: string
  readonly title?: string
  readonly prompt?: string
  readonly spec?: ScheduleSpec
  readonly notify?: 'result'|'failure'|'both'|'none'
  readonly delivery?: FeishuDeliveryInput | null
  readonly expectedUpdatedAt?: string | null
}
export interface ScheduleCommandOutcome {
  readonly state: 'completed'|'rejected'|'not-found'|'conflict'|'error'
  readonly taskId?: string
  readonly message?: string   // bounded, stable code/message only
}
export interface ObservedScheduleTurn {  // also declared in src/types.ts
  readonly sessionId: string
  readonly messageId: string
  readonly text: string
  readonly status: 'success'|'failed'|'timeout'|'empty'
  readonly elapsedMs: number
  readonly model?: string
  readonly tokens?: number
}

export class ScheduleManager {
  constructor(hooks: ScheduleManagerHooks)
  readonly available: boolean
  readonly unavailableReason?: string
  /** Called from apply() when ctx.inject(['schedule']) resolves. */
  attachNative(port: NativeSchedulePort | undefined): void
  /** Called on every native 'schedule/changed' emit (debounce internally). */
  onChanged(): void
  async start(): Promise<void>   // open JsonStores + initial refresh
  async stop(): Promise<void>
  async refresh(): Promise<void> // catalog + native delivery history + read model
  async execute(command: ScheduleCommand): Promise<ScheduleCommandOutcome>
  /** Called when DshSessionBridge observes a schedule-sourced turn. */
  async onScheduleTurn(turn: ObservedScheduleTurn): Promise<void>
  /** True when sessionId belongs to a Gateway-managed scheduled task. */
  isTaskSession(sessionId: string): boolean
  /** Read model (also for tests). */
  snapshot(): ScheduleReadModel
}
```

`src/schedule/native.ts` exports `NativeSchedulePort` (structural wrapper over
`ctx.get('schedule')`: `list`, `view`, `history`, `create`, `edit`, `run`,
`deleteInactive`, `deliveryLimits`) and
`createNativeSchedulePort(ctx: CordisLike): NativeSchedulePort | undefined`.
Every call is wrapped so a native rejection becomes a bounded error string.

### Manager behavior

* `create`: authorize `delivery` through `validateFeishuTarget`; call
  `ensureTaskSession(clientRef)`; `port.create({ title, prompt,
  timing: toNativeTiming(spec), target: { kind:'session', sessionId } })`;
  persist the delivery config + taskId->sessionId map; audit `create`.
* `update`/`pause`/`resume`/`delete`: `port.edit(...)` with
  `expectedUpdatedAt` for optimistic conflict detection; keep the Feishu sidecar
  in sync; `delete` also calls `releaseTaskSession`.
* `run`: `port.run({ id })`; `delete-inactive`: `port.deleteInactive()`;
  `refresh`: `refresh()`.
* Every command appends one bounded audit entry (actor, action, taskId, state,
  parameter summary — **never the prompt text**) to `stateDir/schedule-audit.jsonl`.
* `refresh()` publishes `stateDir/ops-schedule.json` (atomic, 0600), version 1,
  with `available`, optional `reason`, `limits`, `tasks`, `deliveries`, `runs`,
  `audit`. Bounded: <= 200 tasks, <= 20 deliveries/task, <= 200 runs, <= 200 audit.
* `onScheduleTurn(turn)`: look up the task by `turn.sessionId`. If a delivery
  config exists and `validateFeishuTarget` still passes and `notify` allows it,
  send `turn.text` (truncated) through `sendFeishu` with key
  `schedule:<taskId>:<messageId>`. Record one `ScheduleRunRecord` (status,
  elapsedMs, tokens, model, sessionRef, delivered). On failed/empty turns send a
  bounded failure notice when `notify` includes failure. Deduplicate by
  `messageId` (in-memory + persisted run ledger).
* **Fallback notification**: if `refresh()` sees a new native `lastDelivery`
  with no matching run within a long grace (5 min, and never while the native task reports executionActive) period, send one bounded notice
  ("task triggered; result lives in the DSH Session") with key
  `schedule:<taskId>:<messageId>:notice`. This guarantees Feishu notification
  even when Host-created sessions are scope-filtered away from the plugin ctx.
* When `available === false`, publish a read model with a clear `reason`
  (`DSH native schedule service is not mounted in this profile`); never create
  a substitute scheduler.

## 4. Read model (`stateDir/ops-schedule.json`)

```json
{
  "version": 1,
  "ts": 1699000000000,
  "available": true,
  "reason": null,
  "limits": { "newSessionIntervalSeconds": 60 },
  "tasks": [{
    "id": "schedule-...", "title": "...", "prompt": "...",
    "spec": { "kind": "daily", "time": "09:00:00", "timeZone": "Asia/Shanghai" },
    "timingKind": "daily", "timeZone": "Asia/Shanghai",
    "scheduledAt": "2026-11-16T01:00:00.000Z",
    "status": "active", "createdAt": "...", "updatedAt": "...",
    "executionActive": false,
    "lastDelivery": { "scheduledAt": "...", "deliveredAt": "...", "messageId": "...", "targetSessionId": "..." },
    "target": { "kind": "session", "sessionId": "..." },
    "delivery": { "botId": "default", "chatId": "oc_xxx", "chatType": "group", "notify": "both" }
  }],
  "deliveries": { "<taskId>": [ { "scheduledAt": "...", "deliveredAt": "...", "messageId": "...", "targetSessionId": "..." } ] },
  "runs": [{ "ts": 1699000000000, "taskId": "...", "messageId": "...",
             "sessionRef": "<16-hex>", "status": "success", "elapsedMs": 1200,
             "tokens": 123, "model": "...", "delivered": true, "error": null }],
  "audit": [{ "ts": 1699000000000, "actor": "dsh-web-admin", "action": "create",
              "taskId": "...", "state": "completed", "summary": "daily 09:00 Asia/Shanghai" }]
}
```

The Web Admin's `web-admin/src/schedule-read.mjs` reads this file with the same
strict whitelisting style as `ops-read.mjs` (lstat, no symlink, <= 1 MiB,
version check, bounded strings, no raw exception text). It never reads
`inbox.jsonl`, `outbox.json` or `sessions.json`.

## 5. Web Admin HTTP endpoints (`web-admin/src/server.mjs`)

All under `/api/feishu-admin`, behind the existing `security(req, reject)`.

| Method | Route | Body | Result |
| --- | --- | --- | --- |
| GET | `/schedule` | — | `{ ok:true, model }` = sanitized read model |
| POST | `/schedule/preview` | `{ spec, count }` | `{ ok:true, occurrences:[ISO], summary }` (pure, no side effects) |
| POST | `/schedule/commands` | canonical command fields | `202 { ok:true, command:{id,type:'schedule'} }` |
| GET | `/schedule/results` | — | `{ ok:true, commands:[...] }` (recent schedule results) |

`queueOperatorCommand` is extended to accept `type:'schedule'` with a bounded
`schedule` object; it must be serialized with `serializeMutation` and write a
command file <= 8192 bytes with `actor` set by the server (never from the body).

UI: new workbench nav entry `['schedule', '定时任务', '⏱']` and a
`SchedulePanel` in `web-admin/src/schedule-panel.js` (bundled by
`web-admin/scripts/build.mjs`). Panels: task list + detail, create/edit form
(one-time / interval / daily / weekly / monthly / cron, explicit timezone,
preview of next triggers), run controls (pause/resume/run now/delete with
confirmation), run history (native deliveries + Gateway runs), audit trail.
Delivery target select is constrained to the configured bots, allowlist users
and enabled groups from `GET /state`; groups are refused when the current
policy would reject them. Show a clear "native schedule service unavailable"
state instead of pretending tasks exist.

## 6. Gateway wiring (owned by the Lead)

* `src/types.ts`: `CordisLike.inject?(deps, cb)`, `CordisLike.on` listener may
  return `unknown` (waterfall), `SessionBridge.watchScheduleTurns?(handler)`,
  `ObservedScheduleTurn`.
* `src/index.ts` `apply()`: `ctx.inject(['schedule'], scope => {...})` attaches
  `createNativeSchedulePort(scope)`, registers `schedule/changed` ->
  `manager.onChanged()`, and a `schedule/resolve-agent` waterfall that returns
  the Gateway-owned live Agent (`ctx.agents.get(id)`) for `manager.isTaskSession(id)`
  and `next()` otherwise. Fibre-owned disposers.
* `src/session/dsh-session-bridge.ts`: observe `user/message` events with
  `data.source.kind === 'schedule'`, capture `assistant/message` /
  `assistant/attempt` text + usage until `turn/end`, then emit
  `ObservedScheduleTurn` to the registered handler. Mock bridge gets a helper
  to emit one for tests.
* `src/gateway.ts`: construct `ScheduleManager` with `ensureTaskSession`
  (`bridge.create` in the isolated Feishu workspace), `releaseTaskSession`
  (`bridge.retire`), `validateFeishuTarget` (MessageRouter + current managed
  config), `sendFeishu` (`outbox.send` with `chatId`, no `replyToMessageId`);
  `start()`/`stop()` manage the manager, a 10s refresh timer and the bridge
  watcher; `executeOperatorCommand` handles `type:'schedule'`.
* `src/ops/commands.ts`: mail-box type/payload/result extension.

## 7. Tests (no credentials, no network, no live DSH)

* `tests/unit/schedule-spec.test.ts`, `schedule-native.test.ts`,
  `schedule-manager.test.ts` (schedule-core).
* `tests/integration/schedule-commands.test.ts` (Lead): end-to-end via
  `createGateway` with `MockFeishuTransport` + `MockSessionBridge`, writing a
  real `ops-control/requests` file and asserting the result + read model.
* `web-admin/test/schedule.test.mjs` (web-admin): preview validation, command
  enqueue validation, sanitized read model, endpoint auth.
* `pnpm run verify` must stay green (typecheck + build + vitest + web-admin tests).

## 8. Acceptance mapping (Issue #19)

1. Web Admin create daily reminder -> preview next trigger -> save -> survives
   restart: native Host storage + Gateway delivery sidecar + owner lock.
2. Pause/resume/run-now/delete consistent with native state: `port.edit/run`.
3. Execution history + associated Session traceable: native `history()` +
   Gateway run ledger with `sessionRef`; duplicate-send protection via Outbox
   idempotency keys and a persisted dedupe ledger.
4. Unauthorized users cannot modify: authenticated DSH Web `security()` +
   Gateway-side authoritative revalidation; unauthorized Feishu groups/users
   rejected by `MessageRouter`-equivalent allowlist validation.
5. E2E in a real DSH test Profile: documented runbook, never claimed as done
   by CI; Mock tests do not pretend to be real-tenant verification.
