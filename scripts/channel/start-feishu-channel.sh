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
    nohup dsh --profile "$PROFILE" >> "$STATE_DIR/channel.stdout.log" 2>&1 &
    echo $! > "$PID_FILE"
    echo "started (pid $(cat "$PID_FILE")), logs: $STATE_DIR/channel.stdout.log"
    ;;
  "")
    set -a; . "$ENV_FILE"; set +a
    exec dsh --profile "$PROFILE"
    ;;
  *)
    die "unknown option $1 (use --daemon|--status|--stop)"
    ;;
esac
