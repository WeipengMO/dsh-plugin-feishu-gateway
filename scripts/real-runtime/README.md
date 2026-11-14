# Real DSH 0.2.2-rc.1 runtime verification harness

> This is **not** a Mock unit test. It boots the **real DSH headless runtime**
> (`dsh --profile feishu-gateway-test "<task>"`) with real
> `ctx.agents` / `ctx.agentLoop` / `ctx.sessions` / `ctx.llm`, and drives the
> **real `DshSessionBridge`** (`create` / `submit` / `waitForReply` / `resume` /
> `cancel` / `dispose`). `MockSessionBridge` is never used.
>
> `pnpm run verify` passing is **not** evidence that native Sessions work.

## Files

| File | Role |
| --- | --- |
| `mock-llm.mjs` | Stateless OpenAI-compatible SSE test LLM. Every reply is derived **only** from the `messages` array DSH sends (real Session history); no hardcoded answers. Generic extractive memory: tokens matching `/\b[A-Z]{2,}-\d{3,}\b/` found in **earlier** user/assistant messages are returned for recall-style questions. Writes a JSONL request log so context can be verified. `HOST_KEEPALIVE` delays only the headless task so the host stays alive for all 3 turns; `DELAY_MARKER` / `FAIL_MARKER` support timeout / error probes. |
| `native-session-probe.mjs` | Test-only Cordis plugin inserted into the isolated profile. Reads `PROBE_MODE`, `PROBE_OUT_FILE`, `PROBE_STATE_DIR`, `PROBE_WORKSPACE`, `PROBE_SESSION_ID` from env. Instruments the real bridge, logs AgentRegistry / SessionStore / AgentFactory snapshots and `session/event` + `agent/assistant-stream` sequences. |

## Why `HOST_KEEPALIVE` is required

`dsh-headless` calls `io.exit()` as soon as its own one-shot task finishes
(`dsh-headless/lib/index.js:383`), which disposes the root fiber, clears the
agent factory (`dsh-agent/lib/index.js:558-567`) and detaches Sessions. In that
window a probe's 2nd/3rd turn fails with `no agent factory registered` or
`cannot append outside a SessionStore` — a **host-lifecycle artifact, not a
Gateway bug**. The Mock LLM therefore delays the headless task's own LLM call
(45 s) so the SAME process stays a continuously running Host for all three
turns. See `research/dsh-internals.md` for the full source analysis.

## Setup (isolated — never touches `~/.dsh/profiles/web` or the running GUI)

1. Build: `pnpm run build && pnpm run pack`.
2. Create `H1=$(mktemp -d /tmp/dsh-l4-home-XXXXXX)`, copy
   `profiles/feishu-gateway-test/` into `$H1/profiles/`, install the built
   `.tgz` with `dsh plugin --profile ... add`, and symlink
   `@deepseek-ai/dsh-llm` from the CLI's node_modules into the profile (needed
   by `createUserMessage`).
3. Append these rows to `$H1/profiles/feishu-gateway-test/cordis.patch.yml`
   (Mock credentials only — the key value is a placeholder):
   ```yaml
   - id: llm-pi-ai
     name: '@deepseek-ai/dsh-llm-pi-ai'
     config:
       providers:
         mock-route:
           apiKeyEnv: FEISHU_GATEWAY_TEST_LLM_KEY
           api: openai-completions
           baseURL: http://127.0.0.1:18080/v1
           models:
             - id: mock-model
               name: Mock Test Model
               contextWindow: 8192
               maxTokens: 2048
               input: [text]
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config: { provider: mock-route, model: mock-model }
   - insert:
       - name: ./native-session-probe.mjs
         config: { outFile: <H1>/probe-result.json, workspace: <H1>/probe-workspace }
   ```
   Copy the two `.mjs` files into the profile dir; point `stateDir` in the
   `feishu-gateway` row inside `$H1` (never the real `~/.dsh` state).
4. Start: `MOCK_LLM_LOG=$H1/llm-log.jsonl MOCK_LLM_FAIL_PATTERN=FAIL_MARKER node mock-llm.mjs 18080 &`

## Run

```bash
# HOST 1 — one process, 3 consecutive turns
DSH_HOME=$H1 FEISHU_GATEWAY_TEST_LLM_KEY=mock-not-a-real-key \
DSH_PERMISSION_MODE=read-only \
PROBE_MODE=three-turns PROBE_OUT_FILE=$H1/host1.json \
PROBE_STATE_DIR=$H1/round2-state PROBE_WORKSPACE=$H1/round2-workspace \
timeout 180 dsh --profile feishu-gateway-test "HOST_KEEPALIVE 请只回复 OK，不要调用任何工具。"

# HOST 2 — independent new host; copy $H1/sessions + $H1/storages into H2,
# then cold-resume the SAME session id from DSH persistence
DSH_HOME=$H2 PROBE_MODE=resume PROBE_SESSION_ID=<sid from host1.json> ...

# HOST 3 — timeout / cancel / error isolation
DSH_HOME=$H1 PROBE_MODE=isolation PROBE_STATE_DIR=$H1/iso-state ...
```

Turns (exact, from the task):
`请记住字符串 GBM-7429。` → `我上一轮让你记住了什么？` → `请再次重复第一轮的字符串。`

Expected: all three turns share one Session ID; Turn 1 acknowledges, Turns 2/3
return `GBM-7429`; `disposeCalls === 1` (only at `stop()`); AgentRegistry /
SessionStore / AgentFactory all `true`; Host 2's LLM request contains all three
prior User + three prior Assistant messages and answers `GBM-7429`; timeout,
cancel and error each yield a NEW Session with `crossAttributed === 0`.

## Constraints honoured

- No production credential is read or used (placeholder env value only).
- `web` profile, `dsh-web.service`, DSH Core and the running GUI are untouched.
- DSH persistence dir is workspace-scoped; Host 2 reuses the same workspace
  path with a fresh `DSH_HOME`/process.
- All state lives under `/tmp` and is removed by the caller.
