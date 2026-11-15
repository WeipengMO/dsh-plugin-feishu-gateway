# DSH Feishu Admin (management-only companion)

This package adds a native **飞书管理** operations workbench to DSH Web's left sidebar and keeps a separate **飞书 Gateway** credential-only page in Settings.

- The **web** Profile only loads this admin package; it never creates Feishu WebSockets or DSH Agent Sessions.
- The existing **feishu-channel** Profile continues to host the real Feishu gateway.
- API: `/api/feishu-admin/{state,health,diagnostics,config,credentials,restart}` using DSH `webServer` / `connection.requestRejection`.
- No additional HTTP listener or exposed port. Same-origin cookies and non-GET request headers are required.
- Browser UI uses the official `sidebar.panellist` and root-scoped `main` slots for the workbench; `settings.section` / `settings.section.icon` remain for the credential-only form. Both use `ctx.slots.inject` to handle load/unload ordering.
- Workbench views: overview, bots, message delivery, Session & approvals, permissions, diagnostics, advanced configuration. Live aggregates are from the existing authenticated APIs; absent history endpoints are clearly marked unavailable.
- Changes are written atomically to `~/.dsh/feishu-channel-state/admin-config.json` (0600) and loaded by the real gateway **on restart**.
- Feishu App Secret is **write-only** and is stored in `~/.dsh/feishu-channel.env` (0600); never returned to browser clients.
- Restart is limited to `systemctl --user restart dsh-feishu-channel.service` (not arbitrary command execution).

## Installation

See [../docs/MANAGEMENT-WORKBENCH.md](../docs/MANAGEMENT-WORKBENCH.md) for architecture, UI structure, safe rollout and extension roadmap, plus [../docs/WEB-ADMIN.md](../docs/WEB-ADMIN.md) for the existing service deployment.

## Current constraints

The admin service and channel service must run as the same Unix user on the same host, or share access to the configured state and credentials paths. The channel host must expose its pre-existing loopback `/health` and `/diagnostics` endpoints on port 18095. The admin API does not parse or rewrite the user's Profile YAML; settings omitted in the managed overlay continue to inherit from it.
