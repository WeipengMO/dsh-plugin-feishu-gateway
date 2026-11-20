#!/usr/bin/env bash
# Offline smoke tests for proxy-first startup. No network, real credentials or DSH needed.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/state"
cat > "$TMP/env" <<'EOF'
FEISHU_GATEWAY_DEFAULT_APP_ID=cli_0000000000000000
FEISHU_GATEWAY_DEFAULT_APP_SECRET=test-only
FEISHU_CHANNEL_PROXY_URL='http://proxy.example.invalid:8080'
EOF
chmod 600 "$TMP/env"
cat > "$TMP/bin/dsh" <<'EOF'
#!/usr/bin/env bash
{
  echo "selected=${FEISHU_GATEWAY_PROXY_SELECTED:-none}"
  echo "proxy=${HTTP_PROXY:-none}"
  echo "node_proxy=${NODE_USE_ENV_PROXY:-none}"
  echo "bypass=${NO_PROXY:-none}"
  printf 'arguments=%s\n' "$*"
} > "$DSH_CAPTURE"
EOF
cat > "$TMP/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [ -n "${MOCK_CURL_CAPTURE:-}" ]; then printf '%s\n' "$*" >> "$MOCK_CURL_CAPTURE"; fi
[ "${MOCK_PROXY_BROKEN:-0}" != "1" ]
EOF
chmod +x "$TMP/bin/dsh" "$TMP/bin/curl"

run_case() {
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u ALL_PROXY -u NO_PROXY -u no_proxy \
    FEISHU_CHANNEL_ENV_FILE="$TMP/env" \
    FEISHU_CHANNEL_STATE_DIR="$TMP/state" \
    DSH_CAPTURE="$TMP/captured" \
    PATH="$TMP/bin:$PATH" \
    "$ROOT/scripts/channel/start-feishu-channel.sh"
}
cat > "$TMP/state/admin-config.json" <<'EOF'
{"version":1,"config":{"networkProxy":{"enabled":true,"urlEnv":"FEISHU_CHANNEL_PROXY_URL","fallbackDirect":true}}}
EOF

MOCK_PROXY_BROKEN=0 run_case > "$TMP/success"
grep -q 'selected=proxy' "$TMP/captured"
grep -q 'node_proxy=1' "$TMP/captured"
grep -q 'proxy=http://proxy.example.invalid:8080' "$TMP/captured"
! grep -q 'proxy.example.invalid' "$TMP/success"

MOCK_PROXY_BROKEN=1 run_case > "$TMP/fallback" 2>&1
grep -q 'selected=direct' "$TMP/captured"
grep -q 'proxy=none' "$TMP/captured"
grep -q 'node_proxy=0' "$TMP/captured"
grep -q 'falling back to direct' "$TMP/fallback"
! grep -q 'proxy.example.invalid' "$TMP/fallback"

cat > "$TMP/state/admin-config.json" <<'EOF'
{"version":1,"config":{"networkProxy":{"enabled":true,"urlEnv":"FEISHU_CHANNEL_PROXY_URL","fallbackDirect":false}}}
EOF
rm -f "$TMP/captured"
if MOCK_PROXY_BROKEN=1 run_case > "$TMP/strict" 2>&1; then
  echo "expected fail-closed proxy startup to fail" >&2; exit 1
fi
[ ! -e "$TMP/captured" ]
grep -q 'direct fallback disabled' "$TMP/strict"

# The launcher must probe the matching Feishu/Lark domain, not a hard-coded
# China Feishu endpoint for an international-only bot.
cat > "$TMP/state/admin-config.json" <<'EOF'
{"version":1,"config":{"bots":[{"id":"default","enabled":true,"domain":"lark"}],"networkProxy":{"enabled":true,"urlEnv":"FEISHU_CHANNEL_PROXY_URL","fallbackDirect":true}}}
EOF
MOCK_PROXY_BROKEN=0 MOCK_CURL_CAPTURE="$TMP/curl-targets" run_case > "$TMP/lark"
grep -q 'open.larksuite.com/open-apis' "$TMP/curl-targets"
! grep -q 'open.feishu.cn/open-apis' "$TMP/curl-targets"

# Managed exemptions and optional overlays are scoped to this channel.
cat > "$TMP/state/admin-config.json" <<'EOF'
{"version":1,"config":{"networkProxy":{"enabled":true,"fallbackDirect":true,"noProxy":"*.internal,198.51.100.42"}}}
EOF
printf '%s\n' '- id: example-policy' > "$TMP/state/exec-policy.patch.yml"
printf '%s\n' '- id: example-external' > "$TMP/state/extra-plugins.patch.yml"
printf '%s\n' '- id: example-operator' > "$TMP/extra.patch.yml"
MOCK_PROXY_BROKEN=0 FEISHU_CHANNEL_EXTRA_PATCHES="$TMP/extra.patch.yml" run_case > "$TMP/managed"
grep -q 'bypass=localhost,127.0.0.1,::1,\*.internal,198.51.100.42' "$TMP/captured"
grep -q 'exec-policy.patch.yml' "$TMP/captured"
grep -q 'extra-plugins.patch.yml' "$TMP/captured"
grep -q 'extra.patch.yml' "$TMP/captured"

echo "PASS: proxy routing, bypass hosts, extra patches, Lark target and fail-closed startup"
