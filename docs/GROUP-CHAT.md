# Feishu group chat management (Issue #18)

Groups are **disabled by default**, even if the old `allowGroups` switch is true. Existing private conversations and their `allowlist` are unaffected.

## Configure

Open DSH Web → **飞书管理 → 群聊管理**.

1. Set `groupPolicy` to `allowlist` (recommended). `open` includes every group but still restricts senders; its first activation requires an explicit confirmation. `disabled` is the default.
2. Configure trusted Feishu user `open_id` values in `groupSenderAllowlist`. Empty means deny all groups, including `open`.
3. Register each `oc_...` chat id and optionally assign a local display label. Per-group sender allowlists can only restrict access further; the effective group permission is the intersection.
4. Keep `requireMention=true` to respond only when the sender **actually mentions this bot**. To enable auto-replies in a selected group, clear it. All groups default to mention-only.
5. Choose Session isolation: `group_sender` (recommended) separates members; `group_topic_sender` additionally separates topics; `group` and `group_topic` share DSH conversation context between trusted members.
6. Save and restart the **independent** Feishu Gateway. Do not restart while real tasks are executing without accounting for interrupted side effects.

Group policy managed configuration example:

```json
{
  "groupPolicy": "allowlist",
  "groupSenderAllowlist": ["ou_example_user"],
  "groups": [{
    "chatId": "oc_example_group",
    "name": "Research discussion",
    "enabled": true,
    "requireMention": true,
    "sessionScope": "group_sender"
  }]
}
```

These are **configuration values**, not real accounts or identifiers. The example is a fragment, not a replacement for the full admin-config.json document.

## Feishu permissions and @mentions

Subscribe to `im.message.receive_v1`. For @only group messages, grant `im:message.group_at_msg:readonly` (or equivalent); for ordinary **non-@** group messages, the bot needs `im:message.group_msg:readonly` or equivalent. Publishing a revised app configuration or tenant authorization may be required. The saved setting cannot grant Feishu permissions; test in the tenant.

The SDK adapter calls `GET /open-apis/bot/v3/info` to retrieve its own `open_id` and compares it with *structured* `mentions[].id.open_id` (and `mentioned_type=bot`). A plain-text name or `@all` is never sufficient. Without a verified bot identity, mention-required groups fail closed.

## Security guarantees and boundaries

- All incoming group messages require an explicitly enabled group policy and a global sender allowlist match **before** durable Inbox or DSH Session creation.
- Durable Inbox persists chat type, verified mention flag and topic IDs. Replayed or queued records are reauthorized before any native Agent or command execution.
- Group registry keys are separated from direct-message keys; default `group_sender` scope isolates group members. Shared scopes must be chosen explicitly.
- `/cancel` cannot cancel a turn owned by another sender. Tool approvals and cancellation cards match actor, bot, chat, specific message and one-time nonce, rather than merely the chat id.
- Unknown chat types and bot-generated messages are ignored; Feishu message IDs are deduplicated by the existing durable Inbox.
- The group name field is a local administrator label, not a verified Feishu directory value. The UI does not claim to discover group names automatically.
- The admin API is behind authenticated DSH Web and validates both allowed fields and `open` confirmation.

## Verification

Run `pnpm run verify`. CI mocks Feishu/DSH and checks group allowlist, @routing, open policy, Session scope and Web admin confirmation. Full live acceptance requires a Feishu tenant: @ and non-@ delivery, permissions for all-message events, concurrent users, restart/recovery, group-topic mapping, card approvals and private DM regression. CI alone **does not** prove real-tenant group delivery.
