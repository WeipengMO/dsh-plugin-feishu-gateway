# DSH Feishu Admin (management-only companion)

This package adds an authenticated **飞书通道** section to the official DSH Web Settings UI.

- The **web** Profile only loads this admin package; it never creates Feishu WebSockets or DSH Agent Sessions.
- The existing **feishu-channel** Profile continues to host the real Feishu gateway.
- API: `/api/feishu-admin/{state,health,diagnostics,config,credentials,restart}` using DSH `webServer` / `connection.requestRejection`.
- No additional HTTP listener or exposed port. Same-origin cookies and non-GET request headers are required.
- The settings UI uses DSH's official `settings.section` and `settings.section.icon` slots.
- Changes are written atomically to `~/.dsh/feishu-channel-state/admin-config.json` (0600) and loaded by the real gateway **on restart**.
- Feishu App Secret is **write-only** and is stored in `~/.dsh/feishu-channel.env` (0600); never returned to browser clients.
- Restart is limited to `systemctl --user restart dsh-feishu-channel.service` (not arbitrary command execution).

## Installation

See [../docs/WEB-ADMIN.md](../docs/WEB-ADMIN.md) for a safe rollout, systemd service, installation in both Profiles, and acceptance checks.

## Current constraints

The admin service and channel service must run as the same Unix user on the same host, or share access to the configured state and credentials paths. The channel host must expose its pre-existing loopback `/health` and `/diagnostics` endpoints on port 18095. The admin API does not parse or rewrite the user's Profile YAML; settings omitted in the managed overlay continue to inherit from it.
