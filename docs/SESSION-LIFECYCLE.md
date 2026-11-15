# Session lifecycle management — Issue #16

## Ownership boundary

Feishu Gateway owns the Feishu bot/chat → DSH native Session binding only.
The original native DSH conversation, history and model state remain DSH-owned.
No operation here deletes a native DSH Session.

## Phase 1 — inventory and storage (implemented)

In **飞书管理 → Session 管理**, filter history by UTC last-activity date
range, bot ID, chat ID / hashed reference, Session ID / hashed reference,
status, or creation/last-active sort; use pagination.

Authenticated GET /api/feishu-admin/sessions accepts from, to, bot, chat,
session, status, sort, direction, page and pageSize (1–100).
The response exposes only SHA-256-shortened Session and chat references,
not their original identifiers or message text.

The disk panel totals only whitelisted Gateway-owned files: Inbox, Outbox,
bindings, events, runtime snapshot, dedup, Token usage and operator mailbox.
Do not read it as the total size of native DSH history.

## Phase 2 — safe manual archive/unlink (implemented)

For a non-active row, click 归档 or 解除绑定. The browser:
1. Posts to /sessions/preview, which checks DSH authentication, fresh Gateway
   telemetry, last-activity version and pending work, and returns a one-time
   30-second confirmation token.
2. Displays the affected hashed references, estimated binding bytes and
   explicit native-DSH-history-preserved statement for confirmation.
3. Posts the token once to /sessions/commands; the response is QUEUED,
   not proof of completion.

The exclusively owning Gateway process claims the durable mailbox request
at most once, serializes it behind work in the same chat and rechecks
active turns, unresolved Inbox, pending approvals, unsent Outbox, request age
and binding version before applying the change. Results appear in
告警中心 → 最近后台操作结果.

Archive marks a Gateway-local binding as archived; a future successful turn
unarchives it. Unlink removes only the Feishu association; a later message
creates a new DSH Session. DSH-native history survives both.

Do not manually delete a live stateDir or interpret a hashed reference as
an authorization credential.

## Still pending — Phase 3

- Bulk selection, historical Inbox content scrubbing, audit-log cleanup and
  actual measured space reclamation.
- Configurable automatic retention, scheduled dry-run and execution, quota
  threshold enforcement, cleanup recovery and retention audit history.
- Per-Session message/task counts and more precise reclaim estimates.
- Live-tenant, real-Host restart and large-scale cleanup acceptance tests.

These require a separate owner-serialized compaction/retention implementation.
They are NOT silently performed by Archive or Unlink.

## Local verification

Run from the repository root:

    pnpm install --frozen-lockfile
    pnpm run typecheck
    pnpm run build
    pnpm run test
    cd web-admin && node --test test/*.test.mjs

Update both Gateway and Web Admin packages in an isolated test profile before
exercising manual lifecycle actions; a newer UI talking to an older Gateway
will not process the new command types.
