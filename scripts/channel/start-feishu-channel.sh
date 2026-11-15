#!/usr/bin/env bash
# Start the long-running Feishu channel for DSH.
#
# Credentials are NOT stored in this repo. They are read from an env file
# outside the repo (default: $HOME/.dsh/feishu-channel.env, mode 600):
#
#   FEISHU_GATEWAY_DEFAULT_APP_ID=cli_...
#   FEISHU_GATEWAY_DEFAULT_APP_SECRET=...
#
# The model route is whatever the `feishu-channel` profile configures; by
# default it reuses the same provider/model as the web profile
# (magpie / group/deepseek), resolved through the shared DSH credentials store.
#
# Usage:
#   scripts/channel/start-feishu-channel.sh            # foreground
#   scripts/channel/start-feishu-channel.sh --daemon   # background + PID file
#   scripts/channel/start-feishu-channel.sh --status
#   scripts/channel/start-feishu-channel.sh --stop
set -euo pipefail

PROFILE="${FEISHU_CHANNEL_PROFILE:-feishu-channel}"
ENV_FILE="${FEISHU_CHANNEL_ENV_FILE:-$HOME/.dsh/feishu-channel.env}"
STATE_DIR="${FEISHU_CHANNEL_STATE_DIR:-$HOME/.dsh/feishu-channel-state}"
PID_FILE="$STATE_DIR/channel.pid"
HEALTH_PORT="${FEISHU_CHANNEL_HEALTH_PORT:-18095}"

die() { echo "error: $*" >&2; exit 1; }

# Proxy configuration is resolved before the DSH process is started, so the
# native agent's web_fetch/fetch requests can honor NODE_USE_ENV_PROXY too.
# Only the *name* of an env var is stored in managed config. Never echo its URL.
configure_proxy() {
  local cfg_file="$STATE_DIR/admin-config.json"
  local settings enabled env_name fallback proxy_url
  settings="$(node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const doc = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    const p = doc.config?.networkProxy || {};
    if (p.enabled !== undefined && typeof p.enabled !== "boolean") process.exit(2);
    const env = p.urlEnv || "FEISHU_CHANNEL_PROXY_URL";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) process.exit(2);
    console.log(p.enabled === true ? "1" : "0");
    console.log(env);
    console.log(p.fallbackDirect === false ? "0" : "1");
  ' "$cfg_file")" || die "invalid managed proxy configuration"
  local -a fields=()
  mapfile -t fields <<< "$settings"
  enabled="${fields[0]:-0}"
  env_name="${fields[1]:-FEISHU_CHANNEL_PROXY_URL}"
  fallback="${fields[2]:-1}"
  [ "$enabled" = 1 ] || return 0

  proxy_url="${!env_name:-}"
  if [ -n "$proxy_url" ] &&
    node -e '
      try {
        const u = new URL(process.argv[1]);
        if (!["http:", "https:"].includes(u.protocol) || !u.hostname ||
            u.username || u.password || u.search || u.hash || u.pathname !== "/")
          process.exit(1);
      } catch { process.exit(1) }
    ' "$proxy_url" &&
    command -v curl >/dev/null 2>&1 &&
    curl --silent --show-error --output /dev/null --noproxy "" \
      --proxy "$proxy_url" --connect-timeout 3 --max-time 8 \
      "https://open.feishu.cn/open-apis/" 2>/dev/null; then
    export http_proxy="$proxy_url" https_proxy="$proxy_url"
    export HTTP_PROXY="$proxy_url" HTTPS_PROXY="$proxy_url"
    export no_proxy="${no_proxy:-${NO_PROXY:-localhost,127.0.0.1,::1}}"
    export NO_PROXY="$no_proxy"
    export NODE_USE_ENV_PROXY=1
    export FEISHU_GATEWAY_PROXY_SELECTED=proxy
    echo "network route: proxy preflight passed (URL redacted)"
    return 0
  fi

  if [ "$fallback" = 1 ]; then
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY
    export NODE_USE_ENV_PROXY=0
    export FEISHU_GATEWAY_PROXY_SELECTED=direct
    echo "network route: proxy preflight failed; falling back to direct" >&2
  else
    die "proxy enabled but CONNECT preflight failed; direct fallback disabled"
  fi
}

[ -f "$ENV_FILE" ] || die "missing credentials file $ENV_FILE (mode 600). See docs/FEISHU-CHANNEL.md"
chmod 600 "$ENV_FILE" 2>/dev/null || true
mkdir -p "$STATE_DIR"

case "${1:-}" in
  --status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "running (pid $(cat "$PID_FILE"))"
      curl -sS --noproxy "*" --max-time 5 "http://127.0.0.1:$HEALTH_PORT/health" || true
      echo
    else
      echo "not running"
      exit 1
    fi
    ;;
  --stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      PID="$(cat "$PID_FILE")"
      curl -sS --noproxy "*" --max-time 5 -X POST "http://127.0.0.1:$HEALTH_PORT/shutdown" >/dev/null 2>&1 || kill "$PID" 2>/dev/null || true
      for _ in $(seq 1 30); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
      rm -f "$PID_FILE"
      echo "stopped"
    else
      rm -f "$PID_FILE"
      echo "not running"
    fi
    ;;
  --daemon)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      die "already running (pid $(cat "$PID_FILE"))"
    fi
    set -a; . "$ENV_FILE"; set +a
    configure_proxy
    nohup dsh --profile "$PROFILE" >> "$STATE_DIR/channel.stdout.log" 2>&1 &
    echo $! > "$PID_FILE"
    echo "started (pid $(cat "$PID_FILE")), logs: $STATE_DIR/channel.stdout.log"
    ;;
  "")
    set -a; . "$ENV_FILE"; set +a
    configure_proxy
    exec dsh --profile "$PROFILE"
    ;;
  *)
    die "unknown option $1 (use --daemon|--status|--stop)"
    ;;
esac
